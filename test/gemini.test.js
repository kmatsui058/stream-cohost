import fs from 'node:fs';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { GeminiLive, SUMMARY_TIMEOUT_MS } from '../src/gemini.js';
import { logFilePath } from '../src/log.js';
import { fakeLiveAi } from './fakes/live.js';

const cfg = { model: 'gemini-3.8-live', persona: 'PERSONA', silenceDurationMs: 800, triggerTokens: 32000, targetTokens: 16000 };

function fakeMemory() {
  return { instruction: vi.fn(() => 'PERSONA+SUMMARY'), summarize: vi.fn(async () => {}) };
}

describe('live-session', () => {
  let live;
  beforeEach(() => {
    live = fakeLiveAi();
    vi.useFakeTimers();
  });
  afterEach(() => vi.useRealTimers());

  async function connected(memory) {
    const g = new GeminiLive(cfg, live.ai);
    if (memory) g.memory = memory;
    await g.connect();
    return g;
  }

  describe('セッションの設定', () => {
    it('既定の設定で接続する: 音声応答・文字起こし・コンテキスト上限を要求する', async () => {
      await connected();
      const { model, config } = live.last().params;
      expect(model).toBe('gemini-3.8-live');
      expect(config.responseModalities).toEqual(['AUDIO']);
      expect(config.inputAudioTranscription).toEqual({});
      expect(config.outputAudioTranscription).toEqual({});
      expect(config.contextWindowCompression).toEqual({ triggerTokens: '32000', slidingWindow: { targetTokens: '16000' } });
      expect(config.systemInstruction).toBe('PERSONA');
      expect(config.sessionResumption).toEqual({});
      expect(config.realtimeInputConfig.automaticActivityDetection.silenceDurationMs).toBe(800);
    });

    it('memory があれば、その指示でセッションを張る', async () => {
      await connected(fakeMemory());
      expect(live.last().params.config.systemInstruction).toBe('PERSONA+SUMMARY');
    });
  });

  describe('入力を届ける', () => {
    it('確立前の入力: 送らず false を返す', () => {
      const g = new GeminiLive(cfg, live.ai);
      expect(g.sendAudio(Buffer.alloc(10))).toBe(false);
    });

    it('確立後は音声・画像・テキストを決められた形で送る', async () => {
      const g = await connected();
      expect(g.sendAudio(Buffer.from([1, 2]))).toBe(true);
      expect(g.sendFrame('QUJD')).toBe(true);
      expect(g.sendText('やあ')).toBe(true);
      expect(live.last().sent).toEqual([
        { audio: { data: 'AQI=', mimeType: 'audio/pcm;rate=16000' } },
        { video: { data: 'QUJD', mimeType: 'image/jpeg' } },
        { text: 'やあ' },
      ]);
    });

    it('送信中のエラー: 例外を伝えず false を返す', async () => {
      const g = await connected();
      live.last().throwOnSend = true;
      expect(() => g.sendAudio(Buffer.alloc(2))).not.toThrow();
      expect(g.sendAudio(Buffer.alloc(2))).toBe(false);
    });
  });

  describe('AI からのイベントを伝える', () => {
    it('1 通に複数のイベント: 発言の文字起こし → ターン完了の順に伝える', async () => {
      const g = await connected();
      const events = [];
      for (const ev of ['userText', 'modelText', 'interrupted', 'turnComplete']) g.on(ev, (t) => events.push([ev, t]));
      live.last().receive({
        serverContent: {
          modelTurn: { parts: [{ inlineData: { data: 'AAAA', mimeType: 'audio/pcm' } }] },
          outputTranscription: { text: 'こんにちは' },
          turnComplete: true,
        },
      });
      live.last().receive({ serverContent: { inputTranscription: { text: 'おはよう' }, interrupted: true } });
      expect(events).toEqual([
        ['modelText', 'こんにちは'],
        ['turnComplete', undefined],
        ['userText', 'おはよう'],
        ['interrupted', undefined],
      ]);
    });
  });

  describe('予告された切断の前に張り直す', () => {
    it('切断の予告を受けた: 要約して、要約入りの指示で新しいセッションを張り、古いものを閉じる', async () => {
      const mem = fakeMemory();
      const g = await connected(mem);
      const first = live.last();
      mem.instruction.mockReturnValue('PERSONA+NEW_SUMMARY');
      first.receive({ goAway: { timeLeft: '10s' } });
      await vi.advanceTimersByTimeAsync(0);
      expect(mem.summarize).toHaveBeenCalledTimes(1);
      expect(live.sessions).toHaveLength(2);
      expect(live.last().params.config.systemInstruction).toBe('PERSONA+NEW_SUMMARY');
      expect(live.last().params.config.sessionResumption).toEqual({});
      expect(first.closed).toBe(true);
      expect(g.ready).toBe(true);
      // 古いセッションが閉じても再接続は起きない
      await vi.advanceTimersByTimeAsync(60000);
      expect(live.sessions).toHaveLength(2);
    });

    it('張り直し中にもう一度予告を受けた: 2 回目は始まらない', async () => {
      const mem = fakeMemory();
      let finish;
      mem.summarize.mockImplementation(() => new Promise((r) => (finish = r)));
      await connected(mem);
      live.last().receive({ goAway: { timeLeft: '10s' } });
      live.last().receive({ goAway: { timeLeft: '5s' } });
      finish();
      await vi.advanceTimersByTimeAsync(0);
      expect(mem.summarize).toHaveBeenCalledTimes(1);
      expect(live.sessions).toHaveLength(2);
    });
  });

  describe('要約できないときは再開用の情報で張り直す', () => {
    it('要約が失敗した: 最新の再開用ハンドルで張り直す', async () => {
      const mem = fakeMemory();
      mem.summarize.mockRejectedValue(new Error('500'));
      await connected(mem);
      live.last().receive({ sessionResumptionUpdate: { resumable: true, newHandle: 'h1' } });
      live.last().receive({ sessionResumptionUpdate: { resumable: true, newHandle: 'h2' } });
      live.last().receive({ goAway: { timeLeft: '10s' } });
      await vi.advanceTimersByTimeAsync(0);
      expect(live.last().params.config.sessionResumption).toEqual({ handle: 'h2' });
    });

    it('要約が時間内に終わらない: 8 秒で諦めて再開用ハンドルで張り直す', async () => {
      const mem = fakeMemory();
      mem.summarize.mockImplementation(() => new Promise(() => {}));
      await connected(mem);
      live.last().receive({ sessionResumptionUpdate: { resumable: true, newHandle: 'h1' } });
      live.last().receive({ goAway: { timeLeft: '10s' } });
      await vi.advanceTimersByTimeAsync(SUMMARY_TIMEOUT_MS - 1);
      expect(live.sessions).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(live.sessions).toHaveLength(2);
      expect(live.last().params.config.sessionResumption).toEqual({ handle: 'h1' });
    });

    it('resumable でない更新ではハンドルを更新しない', async () => {
      const g = await connected();
      live.last().receive({ sessionResumptionUpdate: { resumable: false, newHandle: 'x' } });
      expect(g.handle).toBeNull();
    });
  });

  describe('予期しない切断から回復する', () => {
    it('接続に失敗し続ける: 1, 2, 4, 8, 16, 30, 30 秒と間隔が伸び、成功したら 1 秒に戻る', async () => {
      const g = await connected();
      const attemptsAt = [];
      const realConnect = live.ai.live.connect;
      live.ai.live.connect = (p) => {
        attemptsAt.push(Date.now());
        return realConnect(p);
      };
      live.ai.failures = Array.from({ length: 6 }, () => new Error('unavailable'));
      const droppedAt = Date.now();
      live.last().drop();
      await vi.advanceTimersByTimeAsync(200_000);
      const gaps = attemptsAt.map((t, i) => t - (i === 0 ? droppedAt : attemptsAt[i - 1]));
      expect(gaps).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000]);
      expect(live.sessions).toHaveLength(2); // 7 回目で成功
      expect(g.ready).toBe(true);
      expect(g.retryMs).toBe(1000);
    });

    it('再開用ハンドルが使えない: 接続直後に切れたら、次は新規のセッションで張る', async () => {
      const mem = fakeMemory();
      mem.summarize.mockRejectedValue(new Error('down'));
      await connected(mem);
      live.last().receive({ sessionResumptionUpdate: { resumable: true, newHandle: 'bad' } });
      live.last().receive({ goAway: { timeLeft: '1s' } });
      await vi.advanceTimersByTimeAsync(0);
      expect(live.last().params.config.sessionResumption).toEqual({ handle: 'bad' });
      await vi.advanceTimersByTimeAsync(1000);
      live.last().drop(1008, 'invalid handle');
      await vi.advanceTimersByTimeAsync(1000);
      expect(live.last().params.config.sessionResumption).toEqual({});
    });

    it('再開用ハンドルで張って十分経ってから切れたら、再びハンドルで張る', async () => {
      await connected();
      live.last().receive({ sessionResumptionUpdate: { resumable: true, newHandle: 'h' } });
      live.last().drop();
      await vi.advanceTimersByTimeAsync(1000);
      expect(live.last().params.config.sessionResumption).toEqual({ handle: 'h' });
      await vi.advanceTimersByTimeAsync(10000);
      live.last().drop();
      await vi.advanceTimersByTimeAsync(1000);
      expect(live.last().params.config.sessionResumption).toEqual({ handle: 'h' });
    });

    it('終了操作による切断: 再接続しない', async () => {
      const g = await connected();
      g.close();
      expect(live.last().closed).toBe(true);
      await vi.advanceTimersByTimeAsync(60000);
      expect(live.sessions).toHaveLength(1);
    });

    it('要約中に古い接続が切れても、セッションは 1 本に収束し古いものは閉じられる', async () => {
      const mem = fakeMemory();
      let finish;
      mem.summarize.mockImplementation(() => new Promise((r) => (finish = r)));
      const g = await connected(mem);
      live.last().receive({ goAway: { timeLeft: '1s' } });
      live.last().drop(); // 要約中に切れる → 1 秒後の再接続が予約される
      await vi.advanceTimersByTimeAsync(1000); // 再接続で 2 本目
      finish();
      await vi.advanceTimersByTimeAsync(0); // 張り直しで 3 本目
      await vi.advanceTimersByTimeAsync(60000);
      const open = live.sessions.filter((s) => !s.closed);
      expect(open).toHaveLength(1);
      expect(open[0]).toBe(g.session);
      expect(g.ready).toBe(true);
    });
  });

  describe('コンテキストの大きさを記録する', () => {
    it('使用量の報告が続けて届く: 通常のログは 1 分に 1 回、詳細ログは毎回', async () => {
      const g = await connected();
      const tokens = [];
      g.on('usage', (t) => tokens.push(t));
      const usage = (n) => ({ usageMetadata: { promptTokenCount: n, responseTokenCount: 10, promptTokensDetails: [{ modality: 'AUDIO', tokenCount: n }] } });
      live.last().receive(usage(100));
      live.last().receive(usage(200));
      live.last().receive(usage(300));
      expect(tokens).toEqual([100, 200, 300]);
      expect(g.promptTokens).toBe(300);
      vi.useRealTimers();
      await new Promise((r) => setTimeout(r, 50));
      const text = fs.readFileSync(logFilePath(), 'utf8');
      expect(text.match(/INFO +\[gemini\] コンテキスト/g)).toHaveLength(1);
      expect(text.match(/DEBUG \[gemini\] usage/g)).toHaveLength(3);
    });
  });
});
