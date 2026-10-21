import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { createApp, HELP } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { logFilePath } from '../src/log.js';
import { fakeLiveAi } from './fakes/live.js';
import { fakeSpawner } from './fakes/process.js';
import { fakeObs } from './fakes/obs.js';
import { silentWav } from './fakes/wav.js';

const env = { GEMINI_API_KEY: 'k', MIC_DEVICE: 'mic', OVERLAY_PORT: '0' };

describe('組み立てと操作', () => {
  let app, live, sp, onQuit, tmp;
  const build = async (extraEnv = {}, { previousState, carryOver } = {}) => {
    live = fakeLiveAi();
    // 答える役（gemini-4-argon）と要約（gemini-3.8-flash）の偽物
    live.ai.models = {
      generateContent: vi.fn(async (req) => ({ text: req.model === 'gemini-4-argon' ? 'はい、マスター。' : '要約' })),
    };
    sp = fakeSpawner();
    onQuit = vi.fn();
    const config = loadConfig({ ...env, ...extraEnv }, () => 'PERSONA');
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cohost-app-'));
    if (previousState) fs.writeFileSync(path.join(tmp, 'carryover.json'), previousState);
    app = createApp(config, {
      ai: live.ai,
      spawn: sp.spawn,
      obsClient: fakeObs(),
      fetch: vi.fn(async () => ({ ok: true, text: async () => '"0.25.2"' })),
      synthesize: async () => silentWav(1),
      summaryFile: path.join(tmp, 'summary.txt'),
      stateFile: path.join(tmp, 'carryover.json'),
      carryOver,
      onQuit,
    });
    await app.start();
    return app;
  };
  afterEach(async () => {
    await app?.shutdown();
  });
  const sent = () => live.last().sent;
  const asks = () => live.ai.models.generateContent.mock.calls.map((c) => c[0]).filter((r) => r.model === 'gemini-4-argon');
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

    it('テキストで話しかける: 待機中に t オルダ、こんにちは → 記録し、召喚して問い合わせる', async () => {
      await build();
      app.handleCommand('t オルダ、こんにちは');
      expect(app.memory.transcript()).toContain('配信者: オルダ、こんにちは');
      expect(app.director.summoned).toBe(true);
      await vi.waitFor(() => expect(asks()).toHaveLength(1));
    });

    it('本文のない t: 何も記録せず、問い合わせない', async () => {
      await build();
      app.handleCommand('t ');
      expect(app.memory.entries).toHaveLength(0);
      expect(asks()).toHaveLength(0);
    });

    it('手で召喚する: o', async () => {
      await build();
      app.handleCommand('o');
      expect(app.director.summoned).toBe(true);
      expect(app.overlay.present).toBe(true);
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

    it('r: 今すぐ要約する', async () => {
      await build();
      const summarize = vi.spyOn(app.memory, 'summarize').mockResolvedValue();
      app.handleCommand('r');
      expect(summarize).toHaveBeenCalledTimes(1);
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

  describe('live-session / 聞く役の配線', () => {
    it('文字起こし専用のモデルに、召喚の言葉を登録語として接続する', async () => {
      await build();
      const p = live.sessions[0].params;
      expect(p.model).toBe('gemini-3.5-transcribe-live');
      expect(p.config.inputAudioTranscription.customVocabulary).toContain('オルダ');
    });

    it('区切られた発話は進行役に渡り、名前があれば召喚して問い合わせ、返事を読み上げ、画面に相方を出す', async () => {
      await build();
      const push = vi.spyOn(app.speaker, 'push');
      live.last().receive({ serverContent: { inputTranscription: { text: 'オルダ、聞こえる?' } } });
      expect(app.overlay.present).toBe(true);
      await vi.waitFor(() => expect(push).toHaveBeenCalledWith('はい、マスター。'));
    });
  });

  describe('conversation-memory / 前回の記憶の引き継ぎ', () => {
    const previous = JSON.stringify({ savedAt: '2026-10-17T13:00:00.000Z', summary: '- 前回は転生クエスト', recent: [] });

    it('前回の記憶がある: 問い合わせの指示に前回の要約が入る', async () => {
      await build({}, { previousState: previous });
      app.handleCommand('t オルダ');
      await vi.waitFor(() => expect(asks()).toHaveLength(1));
      expect(asks()[0].config.systemInstruction).toContain('- 前回は転生クエスト');
    });

    it('テスト用に起動する（引き継がない）: 指示はペルソナだけ', async () => {
      await build({}, { previousState: previous, carryOver: false });
      app.handleCommand('t オルダ');
      await vi.waitFor(() => expect(asks()).toHaveLength(1));
      expect(asks()[0].config.systemInstruction).toBe('PERSONA');
    });

    it('終了する: 記憶を保存してからセッションを閉じる', async () => {
      await build();
      app.memory.add('配信者', '今日はここまで');
      let closedWhenSaved;
      const save = app.memory.save.bind(app.memory);
      app.memory.save = () => {
        closedWhenSaved = live.last().closed;
        save();
      };
      await app.handleCommand('q');
      expect(closedWhenSaved).toBe(false);
      expect(live.last().closed).toBe(true);
      const s = JSON.parse(fs.readFileSync(path.join(tmp, 'carryover.json'), 'utf8'));
      expect(s.recent).toEqual([{ role: '配信者', text: '今日はここまで' }]);
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

  describe('screen-capture / 直近の画面を持っておく', () => {
    it('枚数を超えて取り込む: 直近の 3 枚が古い順に残り、問い合わせに添えられる', async () => {
      await build();
      for (const f of ['f1', 'f2', 'f3', 'f4']) app.obs.emit('frame', f);
      expect(app.frames).toEqual(['f2', 'f3', 'f4']);
      app.handleCommand('t オルダ、これ何?');
      await vi.waitFor(() => expect(asks()).toHaveLength(1));
      const images = asks()[0].contents[0].parts.filter((p) => p.inlineData).map((p) => p.inlineData.data);
      expect(images).toEqual(['f2', 'f3', 'f4']);
    });
  });

  describe('stream-info / 配信の情報を指示に入れる', () => {
    it('起動後に配信の情報を受け取る: 張り直さず、次の問い合わせの指示に入る', async () => {
      await build();
      app.chat.emit('info', { videoId: 'v1', title: '【RO】EP追想#5', description: '概要' });
      expect(live.sessions).toHaveLength(1);
      expect(app.memory.instruction()).toContain('タイトル: 【RO】EP追想#5');
    });
  });

  describe('live-chat / 対象の配信の決め方', () => {
    it('起動後に OBS で配信枠を選ぶ: チャットの対象がその配信に切り替わる', async () => {
      await build({ YOUTUBE_API_KEY: 'yk', YOUTUBE_VIDEO_ID: 'v1' });
      const start = vi.spyOn(app.chat, 'start').mockResolvedValue();
      app.obs.emit('broadcast', 'v2');
      expect(start).toHaveBeenCalledWith('v2');
    });
  });

  describe('live-chat → turn-taking の配線', () => {
    it('取得したチャットは記録される', async () => {
      await build();
      app.chat.emit('messages', [{ author: 'a', text: 'b' }]);
      expect(app.memory.transcript()).toBe('チャット: a: b');
    });
  });
});
