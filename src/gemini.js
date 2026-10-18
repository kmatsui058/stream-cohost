// Gemini Live API とのセッション管理。
// - 入力: マイク PCM（連続）、画面 JPEG（数秒おき）、テキスト（チャット・自発発話の合図）
// - 出力: 現行 Live モデルは音声出力のみ対応のため、音声は捨てて「出力の文字起こし」だけ使う
// - 接続は約 10 分で切れる仕様なので、セッション再開ハンドルで自動的につなぎ直す
import { GoogleGenAI, Modality, MediaResolution } from '@google/genai';
import { EventEmitter } from 'node:events';
import { logger } from './log.js';

const log = logger('gemini');

export class GeminiLive extends EventEmitter {
  constructor(cfg) {
    super();
    this.cfg = cfg;
    this.ai = new GoogleGenAI({ apiKey: cfg.apiKey });
    this.session = null;
    this.ready = false;
    this.handle = null; // セッション再開ハンドル（会話の文脈を引き継ぐ）
    this.closing = false;
    this.retryMs = 1000;
    this.gen = 0; // 古い接続のコールバックを無視するための世代番号
  }

  async connect() {
    const gen = ++this.gen;
    this.ready = false;
    log.info(`接続中 model=${this.cfg.model} resume=${this.handle ? 'あり' : 'なし'}`);
    try {
      this.session = await this.ai.live.connect({
        model: this.cfg.model,
        config: {
          responseModalities: [Modality.AUDIO],
          systemInstruction: this.cfg.persona,
          inputAudioTranscription: {},
          outputAudioTranscription: {},
          // 映像入りだと圧縮なしでは 2 分でセッションが終わるため必須
          contextWindowCompression: { slidingWindow: {} },
          sessionResumption: this.handle ? { handle: this.handle } : {},
          mediaResolution: MediaResolution.MEDIA_RESOLUTION_LOW,
          realtimeInputConfig: {
            automaticActivityDetection: { silenceDurationMs: this.cfg.silenceDurationMs },
          },
        },
        callbacks: {
          onopen: () => {
            if (gen !== this.gen) return;
            this.ready = true;
            this.retryMs = 1000;
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
    if (m.goAway) {
      log.info(`サーバーから切断予告 (残り ${m.goAway.timeLeft})。つなぎ直します`);
      this.reconnectNow();
      return;
    }
    const sc = m.serverContent;
    if (!sc) return;
    if (sc.inputTranscription?.text) this.emit('userText', sc.inputTranscription.text);
    if (sc.outputTranscription?.text) this.emit('modelText', sc.outputTranscription.text);
    if (sc.interrupted) this.emit('interrupted');
    if (sc.turnComplete) this.emit('turnComplete');
  }

  onClose(e) {
    this.ready = false;
    log.warn(`切断 code=${e?.code} reason=${e?.reason || '(なし)'}`);
    // ハンドル起因のエラーで延々失敗しないよう、異常終了ならハンドルを捨てて新規セッションにする
    if (e?.code && e.code !== 1000 && /handle|resum/i.test(e.reason || '')) this.handle = null;
    if (!this.closing) this.scheduleReconnect();
  }

  scheduleReconnect() {
    const ms = this.retryMs;
    this.retryMs = Math.min(this.retryMs * 2, 30000);
    log.info(`${ms / 1000} 秒後に再接続`);
    setTimeout(() => this.connect(), ms);
  }

  reconnectNow() {
    const old = this.session;
    this.connect(); // gen が進むので旧接続の onclose は無視される
    try { old?.close(); } catch {}
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
