import { describe, it, expect, vi, afterEach } from 'vitest';
import { Listener } from '../src/listener.js';
import { fakeLiveAi } from './fakes/live.js';

const cfg = { model: 'gemini-3.5-transcribe-live', silenceDurationMs: 800, vocabulary: ['オルダ', 'ヴァール'] };
const flush = () => new Promise((r) => setImmediate(r));

describe('live-session（聞く役）', () => {
  let listener;
  afterEach(() => {
    listener?.close();
    vi.useRealTimers();
  });

  describe('セッションの設定', () => {
    it('既定の設定で接続する: 文字起こし専用のモデル・テキスト応答・ja-JP・登録語', async () => {
      const live = fakeLiveAi();
      listener = new Listener(cfg, live.ai);
      await listener.connect();
      const p = live.last().params;
      expect(p.model).toBe('gemini-3.5-transcribe-live');
      expect(p.config.responseModalities).toEqual(['TEXT']);
      expect(p.config.inputAudioTranscription).toEqual({ languageCodes: ['ja-JP'], customVocabulary: ['オルダ', 'ヴァール'] });
      expect(p.config.realtimeInputConfig.automaticActivityDetection.silenceDurationMs).toBe(800);
      expect(listener.ready).toBe(true);
    });
  });

  describe('入力を届ける', () => {
    it('確立前の入力: 送らず false を返す', () => {
      listener = new Listener(cfg, fakeLiveAi().ai);
      expect(listener.sendAudio(Buffer.from([1, 2]))).toBe(false);
    });

    it('確立後は音声を 16kHz PCM として送る', async () => {
      const live = fakeLiveAi();
      listener = new Listener(cfg, live.ai);
      await listener.connect();
      expect(listener.sendAudio(Buffer.from([1, 2]))).toBe(true);
      expect(live.last().sent).toEqual([{ audio: { data: Buffer.from([1, 2]).toString('base64'), mimeType: 'audio/pcm;rate=16000' } }]);
    });

    it('送信中のエラー: 例外を伝えず false を返す', async () => {
      const live = fakeLiveAi();
      listener = new Listener(cfg, live.ai);
      await listener.connect();
      live.last().throwOnSend = true;
      expect(listener.sendAudio(Buffer.from([1]))).toBe(false);
    });
  });

  describe('区切られた発話を伝える', () => {
    it('確定した文字起こしだけを 1 件の発話として伝え、途中経過と空白は伝えない', async () => {
      const live = fakeLiveAi();
      listener = new Listener(cfg, live.ai);
      const got = [];
      listener.on('utterance', (t) => got.push(t));
      await listener.connect();
      live.last().receive({ serverContent: { interimInputTranscription: { text: 'オルダ' } } });
      live.last().receive({ serverContent: { inputTranscription: { text: 'オルダ、聞こえる?' } } });
      live.last().receive({ serverContent: { inputTranscription: { text: '  ' } } });
      expect(got).toEqual(['オルダ、聞こえる?']);
    });
  });

  describe('話している途中を伝える', () => {
    it('途中経過が届く: 話している途中として伝え、発話としては伝えない', async () => {
      const live = fakeLiveAi();
      listener = new Listener(cfg, live.ai);
      const interim = [];
      const got = [];
      listener.on('interim', (t) => interim.push(t));
      listener.on('utterance', (t) => got.push(t));
      await listener.connect();
      live.last().receive({ serverContent: { interimInputTranscription: { text: 'ちょっと' } } });
      live.last().receive({ serverContent: { interimInputTranscription: { text: ' ' } } });
      expect(interim).toEqual(['ちょっと']);
      expect(got).toEqual([]);
    });
  });

  describe('予告された切断の前に張り直す', () => {
    it('切断の予告を受けた: 新しいセッションを張り、古いものを閉じる', async () => {
      const live = fakeLiveAi();
      listener = new Listener(cfg, live.ai);
      await listener.connect();
      const first = live.last();
      first.receive({ goAway: { timeLeft: '10s' } });
      await flush();
      expect(live.sessions).toHaveLength(2);
      expect(first.closed).toBe(true);
      expect(listener.ready).toBe(true);
    });

    it('張り直し中にもう一度予告を受けた: 2 回目は始まらない', async () => {
      const live = fakeLiveAi();
      listener = new Listener(cfg, live.ai);
      await listener.connect();
      live.last().receive({ goAway: { timeLeft: '10s' } });
      live.sessions[0].receive({ goAway: { timeLeft: '5s' } });
      await flush();
      expect(live.sessions).toHaveLength(2);
    });
  });

  describe('切断から回復する', () => {
    it('接続に失敗し続ける: 1, 2, 4, 8, 16, 30, 30 秒と伸び、成功したら 1 秒に戻る', async () => {
      vi.useFakeTimers();
      const live = fakeLiveAi();
      live.ai.failures.push(...Array.from({ length: 7 }, () => new Error('down')));
      listener = new Listener(cfg, live.ai);
      await listener.connect();
      for (const ms of [1000, 2000, 4000, 8000, 16000, 30000, 30000]) {
        expect(live.sessions).toHaveLength(0);
        await vi.advanceTimersByTimeAsync(ms);
      }
      expect(live.sessions).toHaveLength(1);
      expect(listener.retryMs).toBe(1000);
    });

    it('予期せず切れた: 1 秒後に張り直す', async () => {
      vi.useFakeTimers();
      const live = fakeLiveAi();
      listener = new Listener(cfg, live.ai);
      await listener.connect();
      live.last().drop();
      expect(listener.ready).toBe(false);
      await vi.advanceTimersByTimeAsync(1000);
      expect(live.sessions).toHaveLength(2);
      expect(listener.ready).toBe(true);
    });

    it('終了操作による切断: 再接続しない', async () => {
      vi.useFakeTimers();
      const live = fakeLiveAi();
      listener = new Listener(cfg, live.ai);
      await listener.connect();
      listener.close();
      await vi.advanceTimersByTimeAsync(60000);
      expect(live.sessions).toHaveLength(1);
    });

    it('古い接続の通知は無視する', async () => {
      const live = fakeLiveAi();
      listener = new Listener(cfg, live.ai);
      const got = [];
      listener.on('utterance', (t) => got.push(t));
      await listener.connect();
      const old = live.last();
      old.receive({ goAway: { timeLeft: '1s' } });
      await flush();
      old.receive({ serverContent: { inputTranscription: { text: '古い' } } });
      expect(got).toEqual([]);
    });
  });
});
