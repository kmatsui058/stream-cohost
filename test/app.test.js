import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createApp, HELP } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { logFilePath } from '../src/log.js';
import { fakeLiveAi } from './fakes/live.js';
import { fakeSpawner } from './fakes/process.js';
import { fakeObs } from './fakes/obs.js';
import { silentWav } from './fakes/wav.js';

const env = { GEMINI_API_KEY: 'k', MIC_DEVICE: 'mic', OVERLAY_PORT: '0' };

describe('組み立てと操作', () => {
  let app, live, sp, onQuit;
  const build = async (extraEnv = {}) => {
    live = fakeLiveAi();
    live.ai.models = { generateContent: vi.fn(async () => ({ text: '要約' })) };
    sp = fakeSpawner();
    onQuit = vi.fn();
    const config = loadConfig({ ...env, ...extraEnv }, () => 'PERSONA');
    app = createApp(config, {
      ai: live.ai,
      spawn: sp.spawn,
      obsClient: fakeObs(),
      fetch: vi.fn(async () => ({ ok: true, text: async () => '"0.25.2"' })),
      synthesize: async () => silentWav(1),
      summaryFile: path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cohost-app-')), 'summary.txt'),
      onQuit,
    });
    await app.start();
    return app;
  };
  afterEach(async () => {
    await app?.shutdown();
    vi.useRealTimers();
  });
  const sent = () => live.last().sent;
  const readLog = async () => {
    await new Promise((r) => setTimeout(r, 50));
    return fs.readFileSync(logFilePath(), 'utf8');
  };

  describe('operator-controls / コンソールからの操作', () => {
    it('一時停止して再開する: p を 2 回', async () => {
      await build();
      app.handleCommand('p');
      expect(app.director.paused).toBe(true);
      app.handleCommand('p');
      expect(app.director.paused).toBe(false);
    });

    it('テキストで話しかける: t こんにちは', async () => {
      await build();
      app.handleCommand('t こんにちは');
      expect(sent()).toContainEqual({ text: 'こんにちは' });
    });

    it('本文のない t: 何も送らない', async () => {
      await build();
      app.handleCommand('t ');
      expect(sent()).toEqual([]);
    });

    it('s: 発話を中断する', async () => {
      await build();
      const stop = vi.spyOn(app.speaker, 'stop');
      app.handleCommand('s');
      expect(stop).toHaveBeenCalled();
    });

    it('v: チャットの取得対象を切り替える', async () => {
      await build();
      const start = vi.spyOn(app.chat, 'start').mockResolvedValue();
      app.handleCommand('v abc123');
      expect(start).toHaveBeenCalledWith('abc123');
    });

    it('r: 要約して張り直す', async () => {
      await build();
      const rotate = vi.spyOn(app.gemini, 'rotate').mockResolvedValue();
      app.handleCommand('r');
      expect(rotate).toHaveBeenCalledWith('手動');
    });

    it('m: 現在の記憶を表示する', async () => {
      await build();
      app.handleCommand('m');
      expect(await readLog()).toContain('現在の記憶');
    });

    it('未知のコマンド: 操作の一覧を表示する', async () => {
      await build();
      app.handleCommand('x');
      expect((await readLog()).split(HELP).length).toBeGreaterThanOrEqual(3); // 起動時 + x
    });
  });

  describe('operator-controls / 終了処理', () => {
    it('q で終了する: マイクを止め、セッションを閉じ、終了を呼ぶ', async () => {
      await build();
      await app.handleCommand('q');
      expect(sp.last().killed).toBe(true);
      expect(live.last().closed).toBe(true);
      expect(onQuit).toHaveBeenCalledTimes(1);
    });
  });

  describe('audio-input / 一時停止中と相方の発話中の扱い', () => {
    const chunk = () => sp.last().stdout.emit('data', Buffer.alloc(3200));
    const audioSent = () => sent().filter((m) => m.audio).length;

    it('通常は送り、一時停止中は送らない', async () => {
      await build();
      chunk();
      expect(audioSent()).toBe(1);
      app.handleCommand('p');
      chunk();
      expect(audioSent()).toBe(1);
    });

    it('発話中は送らない設定が有効: 発話中の断片は送らない', async () => {
      await build({ GATE_MIC_WHILE_SPEAKING: '1' });
      app.speaker.push('喋っています。');
      chunk();
      expect(audioSent()).toBe(0);
    });

    it('発話中は送らない設定が無効（既定）: 発話中も送る', async () => {
      await build();
      app.speaker.push('喋っています。');
      chunk();
      expect(audioSent()).toBe(1);
    });
  });

  describe('screen-capture / 一時停止中は画面を送らない', () => {
    it('一時停止中: 取り込んだ画像は送られない', async () => {
      await build();
      app.obs.emit('frame', 'QUJD');
      app.handleCommand('p');
      app.obs.emit('frame', 'REVG');
      expect(sent().filter((m) => m.video).map((m) => m.video.data)).toEqual(['QUJD']);
    });
  });

  describe('turn-taking / 画面の接続状態の配線', () => {
    it('画面が未接続なら音が届かないと判定し、つながると届くと判定して沈黙の起点を更新する', async () => {
      await build();
      const { port } = app.overlay.server.address();
      expect(app.director.isAudible()).toBe(false);
      app.director.lastActivity = 0;
      const ws = new (await import('ws')).default(`ws://127.0.0.1:${port}`);
      await new Promise((r) => ws.on('open', r));
      await vi.waitFor(() => expect(app.director.isAudible()).toBe(true));
      expect(Date.now() - app.director.lastActivity).toBeLessThan(1000);
      ws.close();
    });
  });

  describe('live-chat → turn-taking の配線', () => {
    it('取得したチャットは進行役に渡る', async () => {
      await build();
      app.chat.emit('messages', [{ author: 'a', text: 'b' }]);
      expect(app.director.chatQueue).toEqual([{ author: 'a', text: 'b' }]);
    });
  });

  describe('live-session / コンテキストが大きくなったら張り直す', () => {
    let rotate;
    beforeEach(async () => {
      await build();
      rotate = vi.spyOn(app.gemini, 'rotate').mockResolvedValue();
    });

    it('上限を超えて場が空いた: 張り直す', () => {
      app.gemini.promptTokens = 24001;
      app.checkRotate();
      expect(rotate).toHaveBeenCalledWith('コンテキスト 24001 > 24000');
    });

    it('上限を超えたが相方が喋っている: 張り直さない', () => {
      app.gemini.promptTokens = 30000;
      app.speaker.push('喋っています。');
      app.checkRotate();
      expect(rotate).not.toHaveBeenCalled();
    });

    it('上限以下なら張り直さない', () => {
      app.gemini.promptTokens = 24000;
      app.checkRotate();
      expect(rotate).not.toHaveBeenCalled();
    });

    it('クールダウン中は張り直さない', () => {
      app.gemini.promptTokens = 30000;
      app.gemini.nextRotateAt = Date.now() + 60_000;
      app.checkRotate();
      expect(rotate).not.toHaveBeenCalled();
    });
  });

  it('live-session / 上限の設定が 0 なら張り直さない', async () => {
    await build({ ROTATE_AT_TOKENS: '0' });
    const rotate = vi.spyOn(app.gemini, 'rotate').mockResolvedValue();
    app.gemini.promptTokens = 1e9;
    app.checkRotate();
    expect(rotate).not.toHaveBeenCalled();
  });

  it('live-session / 要約 API が落ちている: ハンドルで張り直し、5 分間はトークン数で張り直さない', async () => {
    await build();
    live.ai.models.generateContent.mockRejectedValue(new Error('503'));
    for (let i = 0; i < 20; i++) app.memory.add(i % 2 ? '相方' : '配信者', `x${i}`);
    live.last().receive({ sessionResumptionUpdate: { resumable: true, newHandle: 'h' } });
    app.gemini.promptTokens = 30000;
    app.checkRotate();
    await vi.waitFor(() => expect(live.sessions).toHaveLength(2));
    expect(live.last().params.config.sessionResumption).toEqual({ handle: 'h' });
    expect(app.gemini.nextRotateAt - Date.now()).toBeGreaterThan(299_000);
    app.gemini.promptTokens = 30000;
    app.checkRotate();
    await new Promise((r) => setTimeout(r, 20));
    expect(live.sessions).toHaveLength(2);
  });
});
