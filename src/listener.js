// 聞く役: マイク音声を Gemini Live の文字起こし専用モデルに流し、無音で区切られた発話を 1 件ずつ伝える。
// - 返事は生成させない（答えるのは responder.js）。会話の文脈も持たないので、要約も再開用ハンドルも要らない
// - 接続は約 10 分で切れる仕様。切断予告（goAway）が来たら新しいセッションに乗り換える
import { GoogleGenAI, Modality } from '@google/genai';
import { EventEmitter } from 'node:events';
import { logger } from './log.js';

const log = logger('listener');
const MAX_RETRY_MS = 30000;

export class Listener extends EventEmitter {
  constructor(cfg, ai = new GoogleGenAI({ apiKey: cfg.apiKey })) {
    super();
    this.cfg = cfg;
    this.ai = ai;
    this.session = null;
    this.ready = false;
    this.closing = false;
    this.switching = false; // 切断予告による乗り換え中
    this.retryMs = 1000;
    this.gen = 0; // 古い接続のコールバックを無視するための世代番号
  }

  sessionConfig() {
    return {
      responseModalities: [Modality.TEXT],
      inputAudioTranscription: { languageCodes: ['ja-JP'], customVocabulary: this.cfg.vocabulary },
      realtimeInputConfig: {
        automaticActivityDetection: { silenceDurationMs: this.cfg.silenceDurationMs },
      },
    };
  }

  async connect() {
    const gen = ++this.gen;
    log.info(`接続中 model=${this.cfg.model}`);
    let session;
    try {
      session = await this.ai.live.connect({
        model: this.cfg.model,
        config: this.sessionConfig(),
        callbacks: {
          onmessage: (m) => gen === this.gen && this.onMessage(m),
          onerror: (e) => gen === this.gen && log.error('WebSocket エラー', e?.message ?? String(e)),
          onclose: (e) => gen === this.gen && this.onClose(e),
        },
      });
    } catch (e) {
      if (gen !== this.gen || this.closing) return;
      log.error('接続失敗', e.message);
      this.scheduleReconnect();
      return;
    }
    // 待っている間に別の接続が始まった／終了した場合は、この接続を捨てる
    if (gen !== this.gen || this.closing) {
      try { session.close(); } catch {}
      return;
    }
    const prev = this.session;
    this.session = session;
    if (prev && prev !== session) {
      try { prev.close(); } catch {} // 旧世代なので onclose は無視される
    }
    this.ready = true;
    this.retryMs = 1000;
    log.info('接続完了');
  }

  onMessage(m) {
    if (m.goAway) {
      log.info(`サーバーから切断予告 (残り ${m.goAway.timeLeft})`);
      this.switchSession();
      return;
    }
    // 途中経過（interimInputTranscription）は使わず、確定したものだけを発話として伝える
    const text = m.serverContent?.inputTranscription?.text?.trim();
    if (text) this.emit('utterance', text);
  }

  async switchSession() {
    if (this.switching || this.closing) return;
    this.switching = true;
    try {
      await this.connect();
    } finally {
      this.switching = false;
    }
  }

  onClose(e) {
    this.ready = false;
    log.warn(`切断 code=${e?.code} reason=${e?.reason || '(なし)'}`);
    if (!this.closing) this.scheduleReconnect();
  }

  scheduleReconnect() {
    const ms = this.retryMs;
    this.retryMs = Math.min(this.retryMs * 2, MAX_RETRY_MS);
    log.info(`${ms / 1000} 秒後に再接続`);
    const gen = this.gen;
    setTimeout(() => !this.closing && gen === this.gen && this.connect(), ms);
  }

  sendAudio(pcm) {
    if (!this.ready) return false;
    try {
      this.session.sendRealtimeInput({ audio: { data: pcm.toString('base64'), mimeType: 'audio/pcm;rate=16000' } });
      return true;
    } catch (e) {
      log.warn('送信失敗', e.message);
      return false;
    }
  }

  close() {
    this.closing = true;
    this.ready = false;
    try { this.session?.close(); } catch {}
  }
}
