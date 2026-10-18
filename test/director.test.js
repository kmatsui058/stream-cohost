import fs from 'node:fs';
import { EventEmitter } from 'node:events';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Director, IDLE_TOPICS, IDLE_CLOSING } from '../src/director.js';
import { logFilePath } from '../src/log.js';

const cfg = { idleMinSec: 25, idleMaxSec: 45, bargeIn: true };

function fakeGemini() {
  const g = new EventEmitter();
  g.ready = true;
  g.sendText = vi.fn(() => g.ready);
  return g;
}
function fakeSpeaker() {
  const s = new EventEmitter();
  s.speaking = false;
  s.push = vi.fn();
  s.stop = vi.fn(() => (s.speaking = false));
  return s;
}
function fakeMemory() {
  return { add: vi.fn() };
}

describe('turn-taking', () => {
  let gemini, speaker, memory, director;
  const make = (over = {}) => {
    director = new Director({ gemini, speaker, memory, cfg: { ...cfg, ...over }, random: () => 0.5 });
    return director;
  };
  beforeEach(() => {
    vi.useFakeTimers();
    gemini = fakeGemini();
    speaker = fakeSpeaker();
    memory = fakeMemory();
  });
  afterEach(() => {
    director?.dispose();
    vi.useRealTimers();
  });
  const pushed = () => speaker.push.mock.calls.map((c) => c[0]);

  describe('発言を文単位で読み上げに回す', () => {
    it('細切れに届いた発言: 3 文がこの順で回される', () => {
      make();
      for (const t of ['こんにちは、', '相方の', 'テストです。画面', '見えて', 'ますか？', '始めましょう']) gemini.emit('modelText', t);
      gemini.emit('turnComplete');
      expect(pushed()).toEqual(['こんにちは、相方のテストです。', '画面見えてますか？', '始めましょう']);
    });

    it('区切り記号が連続する: 「えっ！？」が 1 文、「本当に」は残る', () => {
      make();
      gemini.emit('modelText', 'えっ！？本当に');
      expect(pushed()).toEqual(['えっ！？']);
      expect(director.buf).toBe('本当に');
    });

    it('改行と ♪ でも区切り、空白だけの残りは回さない', () => {
      make();
      gemini.emit('modelText', 'ららら♪\nはい\n  ');
      gemini.emit('turnComplete');
      expect(pushed()).toEqual(['ららら♪\n', 'はい\n']);
    });

    it('相方の発言を記憶に記録する', () => {
      make();
      gemini.emit('modelText', 'やあ');
      expect(memory.add).toHaveBeenCalledWith('相方', 'やあ');
    });
  });

  describe('配信者の割り込みで黙る', () => {
    it('相方の発話中に配信者が話す: 発話が止まり、記憶に記録する', () => {
      make();
      speaker.speaking = true;
      gemini.emit('userText', 'ちょっと待って');
      expect(speaker.stop).toHaveBeenCalledTimes(1);
      expect(memory.add).toHaveBeenCalledWith('配信者', 'ちょっと待って');
    });

    it('短い雑音: 1 文字では止まらない', () => {
      make();
      speaker.speaking = true;
      gemini.emit('userText', ' あ ');
      expect(speaker.stop).not.toHaveBeenCalled();
    });

    it('設定で無効にしていれば止まらない', () => {
      make({ bargeIn: false });
      speaker.speaking = true;
      gemini.emit('userText', 'ちょっと待って');
      expect(speaker.stop).not.toHaveBeenCalled();
    });

    it('AI からの割り込み通知: 発話が止まり、溜まっていた発言は読み上げない', () => {
      make({ bargeIn: false });
      gemini.emit('modelText', 'それでね');
      gemini.emit('interrupted');
      gemini.emit('turnComplete');
      expect(speaker.stop).toHaveBeenCalledTimes(1);
      expect(pushed()).toEqual([]);
    });
  });

  describe('場が空いているかを判定する', () => {
    it('初期状態で配信者が 3 秒以上黙っていれば空いている', () => {
      make();
      expect(director.quiet).toBe(true);
    });

    it('相方が喋っている／AI が生成中なら空いていない', () => {
      make();
      speaker.speaking = true;
      expect(director.quiet).toBe(false);
      speaker.speaking = false;
      gemini.emit('modelText', '考え中');
      expect(director.quiet).toBe(false);
      gemini.emit('turnComplete');
      expect(director.quiet).toBe(true);
    });

    it('応答待ちが長引いた: 注入から 15 秒経てば空いている', () => {
      make();
      director.inject('テスト');
      vi.advanceTimersByTime(14_999);
      expect(director.quiet).toBe(false);
      vi.advanceTimersByTime(1);
      expect(director.quiet).toBe(true);
    });

    it('配信者が話した直後: 2 秒前なら空いていない、3 秒を過ぎたら空いている', () => {
      make();
      gemini.emit('userText', 'えーと');
      vi.advanceTimersByTime(2000);
      expect(director.quiet).toBe(false);
      vi.advanceTimersByTime(1001);
      expect(director.quiet).toBe(true);
    });
  });

  describe('沈黙が続いたら相方から話しかける', () => {
    it('沈黙が続いた: 合図を 1 回送り、次の秒数を選び直す', () => {
      let r = 0.5;
      director = new Director({ gemini, speaker, memory, cfg, random: () => r }); // 25 + 0.5*20 = 35 秒
      r = 1; // 次は 45 秒
      vi.advanceTimersByTime(35_000);
      expect(gemini.sendText).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1000);
      expect(gemini.sendText).toHaveBeenCalledTimes(1);
      expect(gemini.sendText.mock.calls[0][0]).toMatch(/^【合図】/);
      expect(director.nextIdleSec).toBe(45);
      // 応答が無くても、15 秒の応答待ちと 45 秒の沈黙を過ぎるまでは送らない
      vi.advanceTimersByTime(44_000);
      expect(gemini.sendText).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(2000);
      expect(gemini.sendText).toHaveBeenCalledTimes(2);
    });

    it('自発発話を無効にしている: 長い沈黙でも送らない', () => {
      make({ idleMinSec: 0 });
      vi.advanceTimersByTime(600_000);
      expect(gemini.sendText).not.toHaveBeenCalled();
    });

    it('相方が喋り終えた時点から沈黙を数える', () => {
      make();
      vi.advanceTimersByTime(30_000);
      speaker.emit('idle');
      vi.advanceTimersByTime(30_000);
      expect(gemini.sendText).not.toHaveBeenCalled();
      vi.advanceTimersByTime(6000);
      expect(gemini.sendText).toHaveBeenCalledTimes(1);
    });

    it('セッションが確立していなければ送らない', () => {
      make();
      gemini.ready = false;
      vi.advanceTimersByTime(120_000);
      expect(gemini.sendText).not.toHaveBeenCalled();
    });
  });

  describe('話しかける合図は話題を広げる内容にする', () => {
    const idleTexts = (n, random) => {
      director = new Director({ gemini, speaker, memory, cfg, random });
      for (let i = 0; i < n; i++) vi.advanceTimersByTime(46_000);
      return gemini.sendText.mock.calls.map((c) => c[0]);
    };
    const kindOf = (text) => IDLE_TOPICS.findIndex((t) => text.includes(t));

    it('合図の内容: 話題の切り口と、具体的な質問か提案で締める指示が入っている', () => {
      const [text] = idleTexts(1, () => 0.5);
      expect(text).toMatch(/^【合図】/);
      expect(kindOf(text)).toBeGreaterThanOrEqual(0);
      expect(text).toContain(IDLE_CLOSING);
      expect(IDLE_CLOSING).toMatch(/具体的な質問か提案/);
      expect(IDLE_TOPICS.length).toBeGreaterThanOrEqual(5);
    });

    it.each([
      ['常に 0', () => 0],
      ['常に 0.99', () => 0.99],
      ['ばらばら', (() => { let s = 7; return () => ((s = (s * 9301 + 49297) % 233280) / 233280); })()],
    ])('合図が続く（乱数が%s）: 隣り合う 2 回が同じ種類にならず、2 種類以上を使う', (_, random) => {
      const all = idleTexts(10, random).map(kindOf);
      expect(all.length).toBeGreaterThanOrEqual(10); // 沈黙の秒数は乱数で 25〜45 秒なので、10 回以上出る
      const kinds = all.slice(0, 10);
      expect(kinds.every((k) => k >= 0)).toBe(true);
      for (let i = 1; i < kinds.length; i++) expect(kinds[i]).not.toBe(kinds[i - 1]);
      expect(new Set(kinds).size).toBeGreaterThanOrEqual(2);
    });
  });

  describe('チャットは場が空いたときにまとめて渡す', () => {
    const chats = (n, from = 0) => Array.from({ length: n }, (_, i) => ({ author: `u${from + i}`, text: `c${from + i}` }));

    it('チャットが 7 件溜まっている: 古い順に 5 件、次に 2 件を渡す', () => {
      make();
      director.addChat(chats(7));
      vi.advanceTimersByTime(1000);
      expect(gemini.sendText).toHaveBeenCalledTimes(1);
      expect(gemini.sendText.mock.calls[0][0]).toBe('【チャット】\nu0: c0\nu1: c1\nu2: c2\nu3: c3\nu4: c4');
      expect(memory.add).toHaveBeenCalledWith('チャット', 'u0: c0');
      // 応答が届いて完了したら、次の 2 件
      gemini.emit('modelText', 'ありがとう。');
      gemini.emit('turnComplete');
      vi.advanceTimersByTime(1000);
      expect(gemini.sendText).toHaveBeenCalledTimes(2);
      expect(gemini.sendText.mock.calls[1][0]).toBe('【チャット】\nu5: c5\nu6: c6');
    });

    it('チャットがあふれた: 最新の 20 件だけが残る', () => {
      make();
      director.addChat(chats(25));
      expect(director.chatQueue).toHaveLength(20);
      expect(director.chatQueue[0].author).toBe('u5');
    });

    it('チャットは沈黙時の合図より優先する', () => {
      make();
      vi.advanceTimersByTime(34_000);
      director.addChat(chats(1));
      vi.advanceTimersByTime(3000);
      expect(gemini.sendText.mock.calls.map((c) => c[0].slice(0, 6))).toEqual(['【チャット】']);
    });

    it('送れなかったチャットはキューに残す', () => {
      make();
      gemini.sendText.mockReturnValueOnce(false);
      director.addChat(chats(2));
      vi.advanceTimersByTime(1000);
      expect(director.chatQueue).toHaveLength(2);
      expect(memory.add).not.toHaveBeenCalled();
    });
  });

  describe('セッションの張り直し直後に状態を戻す', () => {
    it('応答の生成中に張り直した: 溜まった発言を回し、生成中で止まらない', () => {
      make();
      gemini.emit('modelText', '途中まで');
      expect(director.quiet).toBe(false);
      gemini.emit('open');
      expect(pushed()).toEqual(['途中まで']);
      expect(director.quiet).toBe(true);
    });
  });

  describe('画面が未接続のときは自分から話しかけない', () => {
    let audible;
    const makeQuiet = () => {
      audible = false;
      director = new Director({ gemini, speaker, memory, cfg, random: () => 0.5, isAudible: () => audible });
    };

    it('画面をつなぐ前に長い沈黙が続く: 合図を送らない', () => {
      makeQuiet();
      vi.advanceTimersByTime(120_000);
      expect(gemini.sendText).not.toHaveBeenCalled();
    });

    it('画面をつなぐ前にチャットが届く: つながる前は渡さず、つながった後に渡す', () => {
      makeQuiet();
      director.addChat([{ author: 'a', text: 'b' }]);
      vi.advanceTimersByTime(10_000);
      expect(gemini.sendText).not.toHaveBeenCalled();
      audible = true;
      vi.advanceTimersByTime(1000);
      expect(gemini.sendText).toHaveBeenCalledWith('【チャット】\na: b');
    });

    it('画面をつなぐ前に配信者が話しかける: AI の発言はこれまでどおり読み上げに回す', () => {
      makeQuiet();
      gemini.emit('modelText', 'はい。');
      expect(pushed()).toEqual(['はい。']);
    });
  });

  describe('画面がつながった時点から沈黙を数える', () => {
    it('長い待ちの後に画面をつなぐ: つながった時点から沈黙の秒数が経つまで合図を送らない', () => {
      let audible = false;
      director = new Director({ gemini, speaker, memory, cfg, random: () => 0.5, isAudible: () => audible }); // 35 秒
      vi.advanceTimersByTime(300_000);
      audible = true;
      director.markActivity();
      vi.advanceTimersByTime(35_000);
      expect(gemini.sendText).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1000);
      expect(gemini.sendText).toHaveBeenCalledTimes(1);
    });
  });

  describe('自発発話を控えていることを記録する', () => {
    it('未接続のまま時間が経つ: 控えるログと再開のログを 1 回ずつ記録する', async () => {
      let audible = false;
      director = new Director({ gemini, speaker, memory, cfg, isAudible: () => audible });
      vi.advanceTimersByTime(60_000);
      audible = true;
      vi.advanceTimersByTime(5000);
      vi.useRealTimers();
      await new Promise((r) => setTimeout(r, 50));
      const text = fs.readFileSync(logFilePath(), 'utf8');
      expect(text.match(/画面が未接続のため、自分から話しかけるのを控えます/g)).toHaveLength(1);
      expect(text.match(/画面がつながったので、自分から話しかけるのを再開します/g)).toHaveLength(1);
    });
  });

  describe('一時停止', () => {
    it('一時停止すると発話を止め、区切り前の発言を捨てる', () => {
      make();
      gemini.emit('modelText', '途中');
      director.setPaused(true);
      expect(speaker.stop).toHaveBeenCalled();
      gemini.emit('turnComplete');
      expect(pushed()).toEqual([]);
    });

    it('一時停止中に AI の発言が届く: 読み上げに回さない', () => {
      make();
      director.setPaused(true);
      gemini.emit('modelText', 'こんにちは。');
      gemini.emit('open');
      expect(pushed()).toEqual([]);
    });

    it('一時停止中にチャットが溜まる: 送らず、再開後に送る', () => {
      make();
      director.setPaused(true);
      director.addChat([{ author: 'a', text: 'b' }]);
      vi.advanceTimersByTime(60_000);
      expect(gemini.sendText).not.toHaveBeenCalled();
      director.setPaused(false);
      vi.advanceTimersByTime(1000);
      expect(gemini.sendText).toHaveBeenCalledWith('【チャット】\na: b');
    });
  });
});
