// Gemini Live API とのセッション管理。
// - 入力: マイク PCM（連続）、画面 JPEG（数秒おき）、テキスト（チャット・自発発話の合図）
// - 出力: 現行 Live モデルは音声出力のみ対応のため、音声は捨てて「出力の文字起こし」だけ使う
// - 接続は約 10 分で切れる仕様。切れる前（goAway）や文脈が大きくなったときに「ローテーション」する:
//     1. memory で要約を作る
//     2. 要約入りの systemInstruction で「新規」セッションを張る（再開ハンドルは使わない）
//   要約に失敗したら、再開ハンドルでつなぎ直す（文脈はサーバー側で保持）
import { GoogleGenAI, Modality, MediaResolution } from '@google/genai';
import { EventEmitter } from 'node:events';
import { logger } from './log.js';

const log = logger('gemini');
export const SUMMARY_TIMEOUT_MS = 8000;
const BAD_HANDLE_WINDOW_MS = 5000;
const MAX_RETRY_MS = 30000;
const USAGE_INFO_INTERVAL_MS = 60000;
export const ROTATE_COOLDOWN_MS = 60_000;
export const ROTATE_COOLDOWN_AFTER_FAILURE_MS = 300_000;

const withTimeout = (p, ms) => {
  let t;
  return Promise.race([
    p,
    new Promise((_, rej) => (t = setTimeout(() => rej(new Error(`タイムアウト ${ms}ms`)), ms))),
  ]).finally(() => clearTimeout(t));
};

export class GeminiLive extends EventEmitter {
  constructor(cfg, ai = new GoogleGenAI({ apiKey: cfg.apiKey })) {
    super();
    this.cfg = cfg;
    this.ai = ai;
    this.memory = null; // app.js でセットする
    this.session = null;
    this.ready = false;
    this.handle = null; // セッション再開ハンドル（要約に失敗したときの予備）
    this.closing = false;
    this.rotating = false;
    this.retryMs = 1000;
    this.gen = 0; // 古い接続のコールバックを無視するための世代番号
    this.closedGen = 0; // 確立前に閉じた世代
    this.openedAt = 0;
    this.usedHandle = false;
    this.lastUsageLog = -Infinity;
    this.promptTokens = 0;
    this.nextRotateAt = 0; // トークン起因の張り直しをこの時刻まで控える
  }

  sessionConfig(systemInstruction) {
    return {
      responseModalities: [Modality.AUDIO],
      systemInstruction,
      inputAudioTranscription: {},
      outputAudioTranscription: {},
      // 1 本の接続の中での上限。超えたら古いものから捨てられる（要約はされない）
      // 映像入りだと圧縮なしでは 2 分でセッションが終わるので、これは必須
      contextWindowCompression: {
        triggerTokens: String(this.cfg.triggerTokens),
        slidingWindow: { targetTokens: String(this.cfg.targetTokens) },
      },
      sessionResumption: this.usedHandle ? { handle: this.handle } : {},
      mediaResolution: MediaResolution.MEDIA_RESOLUTION_LOW,
      realtimeInputConfig: {
        automaticActivityDetection: { silenceDurationMs: this.cfg.silenceDurationMs },
      },
    };
  }

  async connect({ resume = false } = {}) {
    const gen = ++this.gen;
    this.ready = false;
    this.usedHandle = resume && !!this.handle;
    const systemInstruction = this.memory ? this.memory.instruction() : this.cfg.persona;
    log.info(`接続中 model=${this.cfg.model} 方式=${this.usedHandle ? '再開ハンドル' : '新規'} 指示=${systemInstruction.length}文字`);
    let session;
    try {
      session = await this.ai.live.connect({
        model: this.cfg.model,
        config: this.sessionConfig(systemInstruction),
        callbacks: {
          onmessage: (m) => gen === this.gen && this.onMessage(m),
          onerror: (e) => gen === this.gen && log.error('WebSocket エラー', e?.message ?? String(e)),
          onclose: (e) => gen === this.gen && this.onClose(e),
        },
      });
    } catch (e) {
      if (gen !== this.gen || this.closing) return;
      log.error('接続失敗', e.message);
      this.scheduleReconnect({ resume });
      return;
    }
    // 待っている間に別の接続が始まった／終了した場合は、この接続を捨てる
    if (gen !== this.gen || this.closing) {
      try { session.close(); } catch {}
      return;
    }
    if (this.closedGen === gen) return; // 確立直後に切れた（onClose が再接続を予約済み）
    // セッションを受け取ってから送信可能にする（onopen の時点ではまだ session が無い）
    const prev = this.session;
    this.session = session;
    if (prev && prev !== session) {
      try { prev.close(); } catch {} // 旧世代なので onclose は無視される
    }
    this.ready = true;
    this.openedAt = Date.now();
    this.retryMs = 1000;
    this.promptTokens = 0;
    log.info('接続完了');
    this.emit('open');
  }

  onMessage(m) {
    if (m.sessionResumptionUpdate?.resumable && m.sessionResumptionUpdate.newHandle) {
      this.handle = m.sessionResumptionUpdate.newHandle;
      log.debug('再開ハンドル更新');
    }
    if (m.usageMetadata) this.onUsage(m.usageMetadata);
    if (m.goAway) {
      log.info(`サーバーから切断予告 (残り ${m.goAway.timeLeft})`);
      this.rotate('goAway');
      return;
    }
    const sc = m.serverContent;
    if (!sc) return;
    if (sc.inputTranscription?.text) this.emit('userText', sc.inputTranscription.text);
    if (sc.outputTranscription?.text) this.emit('modelText', sc.outputTranscription.text);
    if (sc.interrupted) this.emit('interrupted');
    if (sc.turnComplete) this.emit('turnComplete');
  }

  onUsage(u) {
    this.promptTokens = u.promptTokenCount ?? this.promptTokens;
    const detail = (u.promptTokensDetails ?? []).map((d) => `${d.modality}=${d.tokenCount}`).join(' ');
    log.debug(`usage prompt=${u.promptTokenCount} response=${u.responseTokenCount} ${detail}`);
    if (Date.now() - this.lastUsageLog >= USAGE_INFO_INTERVAL_MS) {
      this.lastUsageLog = Date.now();
      log.info(`コンテキスト ${u.promptTokenCount} tokens (${detail})`);
    }
    this.emit('usage', this.promptTokens);
  }

  onClose(e) {
    const wasReady = this.ready;
    this.ready = false;
    this.closedGen = this.gen;
    log.warn(`切断 code=${e?.code} reason=${e?.reason || '(なし)'}`);
    if (this.closing) return;
    // 再開ハンドルでつないで 5 秒以内に落ちたなら、ハンドルが悪いとみなして次は新規で張る
    const badHandle = this.usedHandle && (!wasReady || Date.now() - this.openedAt < BAD_HANDLE_WINDOW_MS);
    if (badHandle) this.handle = null;
    this.scheduleReconnect({ resume: !!this.handle });
  }

  scheduleReconnect(opts) {
    const ms = this.retryMs;
    this.retryMs = Math.min(this.retryMs * 2, MAX_RETRY_MS);
    log.info(`${ms / 1000} 秒後に再接続`);
    const gen = this.gen;
    // 待っている間に張り直し等で別の接続が始まっていたら、この予約は捨てる
    setTimeout(() => !this.closing && gen === this.gen && this.connect(opts), ms);
  }

  // 要約してから新規セッションに乗り換える。要約できなければ再開ハンドルで乗り換える
  async rotate(reason) {
    if (this.rotating || this.closing) return;
    this.rotating = true;
    log.info(`ローテーション開始 (${reason})`);
    let resume = false;
    try {
      if (!this.memory) throw new Error('memory 未設定');
      await withTimeout(this.memory.summarize(), SUMMARY_TIMEOUT_MS);
      this.nextRotateAt = Date.now() + ROTATE_COOLDOWN_MS;
    } catch (e) {
      log.warn(`要約に失敗したので再開ハンドルで続行: ${e.message}`);
      resume = !!this.handle;
      // 要約 API が落ちているときに張り直しを連発しないよう、トークン起因の張り直しを止める
      this.nextRotateAt = Date.now() + ROTATE_COOLDOWN_AFTER_FAILURE_MS;
    }
    try {
      await this.connect({ resume }); // 成功すれば旧セッションは connect 内で閉じられる
    } finally {
      this.rotating = false;
    }
  }

  send(params) {
    if (!this.ready) return false;
    try {
      this.session.sendRealtimeInput(params);
      return true;
    } catch (e) {
      log.warn('送信失敗', e.message);
      return false;
    }
  }

  sendAudio(pcm) {
    return this.send({ audio: { data: pcm.toString('base64'), mimeType: 'audio/pcm;rate=16000' } });
  }

  sendFrame(jpegBase64) {
    return this.send({ video: { data: jpegBase64, mimeType: 'image/jpeg' } });
  }

  sendText(text) {
    log.info(`→ テキスト注入: ${text.replace(/\n/g, ' / ')}`);
    return this.send({ text });
  }

  close() {
    this.closing = true;
    this.ready = false;
    try { this.session?.close(); } catch {}
  }
}
