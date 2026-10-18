// Gemini Live API とのセッション管理。
// - 入力: マイク PCM（連続）、画面 JPEG（数秒おき）、テキスト（チャット・自発発話の合図）
// - 出力: 現行 Live モデルは音声出力のみ対応のため、音声は捨てて「出力の文字起こし」だけ使う
// - 接続は約 10 分で切れる仕様。切れる前（goAway）や文脈が大きくなったときに「ローテーション」する:
//     1. memory で要約を作る
//     2. 要約入りの systemInstruction で「新規」セッションを張る（再開ハンドルは使わない）
//   要約に失敗したら、従来どおり再開ハンドルでつなぎ直す（文脈はサーバー側で保持）
import { GoogleGenAI, Modality, MediaResolution } from '@google/genai';
import { EventEmitter } from 'node:events';
import { logger } from './log.js';

const log = logger('gemini');
const SUMMARY_TIMEOUT_MS = 8000;

const withTimeout = (p, ms) =>
  Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`タイムアウト ${ms}ms`)), ms))]);

export class GeminiLive extends EventEmitter {
  constructor(cfg, ai) {
    super();
    this.cfg = cfg;
    this.ai = ai ?? new GoogleGenAI({ apiKey: cfg.apiKey });
    this.memory = null; // main.js でセットする
    this.session = null;
    this.ready = false;
    this.handle = null; // セッション再開ハンドル（要約に失敗したときの予備）
    this.closing = false;
    this.rotating = false;
    this.retryMs = 1000;
    this.gen = 0; // 古い接続のコールバックを無視するための世代番号
    this.openedAt = 0;
    this.usedHandle = false;
    this.lastUsageLog = 0;
    this.promptTokens = 0;
    this.nextRotateAt = 0; // トークン起因の張り直しをこの時刻まで控える
  }

  async connect({ resume = false } = {}) {
    const gen = ++this.gen;
    this.ready = false;
    this.usedHandle = resume && !!this.handle;
    const systemInstruction = this.memory ? this.memory.instruction() : this.cfg.persona;
    log.info(`接続中 model=${this.cfg.model} 方式=${this.usedHandle ? '再開ハンドル' : '新規'} 指示=${systemInstruction.length}文字`);
    try {
      this.session = await this.ai.live.connect({
        model: this.cfg.model,
        config: {
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
        },
        callbacks: {
          onopen: () => {
            if (gen !== this.gen) return;
            this.ready = true;
            this.openedAt = Date.now();
            this.promptTokens = 0;
            log.info('接続完了');
            this.emit('open');
          },
          onmessage: (m) => gen === this.gen && this.onMessage(m),
          onerror: (e) => gen === this.gen && log.error('WebSocket エラー', e.message ?? String(e)),
          onclose: (e) => gen === this.gen && this.onClose(e),
        },
      });
    } catch (e) {
      log.error('接続失敗', e.message);
      this.scheduleReconnect();
    }
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
    // info には 1 分に 1 回だけ出す
    if (Date.now() - this.lastUsageLog > 60000) {
      this.lastUsageLog = Date.now();
      log.info(`コンテキスト ${u.promptTokenCount} tokens (${detail})`);
    }
    this.emit('usage', this.promptTokens);
  }

  onClose(e) {
    this.ready = false;
    log.warn(`切断 code=${e?.code} reason=${e?.reason || '(なし)'}`);
    if (this.closing) return;
    // 再開ハンドルでつないで 5 秒以内に落ちたなら、ハンドルが悪いとみなして次は新規で張る
    const resume = !(this.usedHandle && Date.now() - this.openedAt < 5000) && !!this.handle;
    if (!resume) this.handle = null;
    this.scheduleReconnect({ resume });
  }

  scheduleReconnect(opts) {
    const ms = this.retryMs;
    this.retryMs = Math.min(this.retryMs * 2, 30000);
    log.info(`${ms / 1000} 秒後に再接続`);
    setTimeout(() => this.connect(opts), ms);
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
      this.nextRotateAt = Date.now() + 60_000;
    } catch (e) {
      log.warn(`要約に失敗したので再開ハンドルで続行: ${e.message}`);
      resume = !!this.handle;
      // 要約 API が落ちているときに張り直しを連発しないよう、トークン起因の張り直しを 5 分止める
      this.nextRotateAt = Date.now() + 300_000;
    }
    const old = this.session;
    await this.connect({ resume }); // gen が進むので旧接続の onclose は無視される
    try { old?.close(); } catch {}
    this.rotating = false;
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
    this.session?.close();
  }
}
