import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { Director, splitSentences, isSilentReply, DISMISS_MARKER } from '../src/director.js';
import { Memory } from '../src/memory.js';
import { logFilePath } from '../src/log.js';
import { Lorebook } from '../src/lorebook.js';

function fakeSpeaker() {
  const s = new EventEmitter();
  s.speaking = false;
  s.pushed = [];
  s.push = vi.fn((t) => s.pushed.push(t));
  s.stop = vi.fn();
  s.volumes = [];
  s.setVolume = vi.fn((v) => s.volumes.push(v));
  return s;
}

// 返事を 1 つずつ手で返せる答える役
function manualResponder() {
  const calls = [];
  return {
    calls,
    ask: vi.fn((req) => new Promise((resolve, reject) => calls.push({ req, resolve, reject }))),
    reply: async (text) => {
      calls.shift().resolve(text);
      await flush();
    },
  };
}

const flush = () => new Promise((r) => setTimeout(r, 0));
const readLog = async () => {
  await flush();
  await new Promise((r) => setTimeout(r, 30));
  return fs.readFileSync(logFilePath(), 'utf8');
};

function setup({ cfg = {}, frames = [], lorebook } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cohost-dir-'));
  const memory = new Memory({
    ai: { models: { generateContent: vi.fn(async () => ({ text: '要約' })) } },
    model: 'm', maxChars: 4000, recentEntries: 12, persona: 'PERSONA',
    summaryFile: path.join(dir, 'summary.txt'), stateFile: path.join(dir, 'state.json'),
  });
  const speaker = fakeSpeaker();
  const responder = manualResponder();
  const presence = [];
  const director = new Director({
    responder, speaker, memory,
    cfg: { bargeIn: 'duck', duckVolume: 0.3, duckReleaseMs: 1000, ...cfg },
    summonWords: ['オルダ', 'ヴァール'],
    getFrames: () => frames,
    lorebook,
  });
  director.on('presence', (v) => presence.push(v));
  return { director, memory, speaker, responder, presence };
}

describe('turn-taking / answering（召喚・会話・退去）', () => {
  afterEach(() => vi.useRealTimers());

  describe('名前で召喚する', () => {
    it('名前を呼ぶ: 召喚され、問い合わせが行われる', () => {
      const { director, responder, presence } = setup();
      director.onUtterance('オルダ、ニブルヘイムってどんな場所?');
      expect(director.summoned).toBe(true);
      expect(presence).toEqual([true]);
      expect(responder.ask).toHaveBeenCalledTimes(1);
    });

    it('名前を呼ばない独り言: 問い合わせず、記録はする', () => {
      const { director, responder, memory } = setup();
      director.onUtterance('合ってるか、こっちで。');
      expect(director.summoned).toBe(false);
      expect(responder.ask).not.toHaveBeenCalled();
      expect(memory.transcript()).toBe('配信者: 合ってるか、こっちで。');
    });

    it('ひらがなで書き起こされても召喚する', () => {
      const { director } = setup();
      director.onUtterance('おるだ、聞こえる?');
      expect(director.summoned).toBe(true);
    });

    it('チャットで名前を呼ぶ: 召喚され、問い合わせが行われる', () => {
      const { director, responder, memory } = setup();
      director.addChat([{ author: 'Aさん', text: 'オルダちゃんこんばんは' }]);
      expect(director.summoned).toBe(true);
      expect(responder.ask).toHaveBeenCalledTimes(1);
      expect(memory.transcript()).toBe('チャット: Aさん: オルダちゃんこんばんは');
    });

    it('待機中の名前のないチャット: 問い合わせず、記録はする', () => {
      const { director, responder, memory } = setup();
      director.addChat([{ author: 'Aさん', text: 'こんばんは' }, { author: 'Bさん', text: '草' }]);
      expect(responder.ask).not.toHaveBeenCalled();
      expect(memory.entries).toHaveLength(2);
    });
  });

  describe('召喚中の発話に答える', () => {
    it('召喚中に配信者が話す: 指示・記録・画面を渡して問い合わせる（名前がなくても）', async () => {
      const { director, responder } = setup({ frames: ['f1', 'f2', 'f3'] });
      director.onUtterance('オルダ');
      await responder.reply('はい、マスター。');
      director.onUtterance('この敵の弱点は?');
      expect(responder.ask).toHaveBeenCalledTimes(2);
      const req = responder.calls[0].req;
      expect(req.instruction).toBe('PERSONA');
      expect(req.transcript.split('\n').at(-1)).toBe('配信者: この敵の弱点は?');
      expect(req.frames).toEqual(['f1', 'f2', 'f3']);
    });

    it('召喚中にチャットが届く: 問い合わせる', async () => {
      const { director, responder } = setup();
      director.onUtterance('オルダ');
      await responder.reply('はい。');
      director.addChat([{ author: 'Aさん', text: 'こんばんは' }]);
      expect(responder.ask).toHaveBeenCalledTimes(2);
    });

    it('問い合わせ中に続けて話す: 記録に加え、返事の後にもう 1 回だけまとめて問い合わせる', async () => {
      const { director, responder, memory } = setup();
      director.onUtterance('オルダ、質問');
      director.onUtterance('一つ目');
      director.onUtterance('二つ目');
      expect(responder.ask).toHaveBeenCalledTimes(1);
      await responder.reply('スルー');
      expect(responder.ask).toHaveBeenCalledTimes(2);
      expect(responder.calls[0].req.transcript).toContain('配信者: 一つ目\n配信者: 二つ目');
      await responder.reply('スルー');
      expect(responder.ask).toHaveBeenCalledTimes(2);
      expect(memory.entries.filter((e) => e.role === '配信者')).toHaveLength(3);
    });
  });

  describe('返事を読み上げる', () => {
    it('返事が届く: 文に区切ってこの順に読み上げに回し、相方の発言として記録する', async () => {
      const { director, responder, speaker, memory } = setup();
      director.onUtterance('オルダ、この敵の弱点は?');
      await responder.reply('弱点は火属性です。ただ、耐性装備の可能性もあります。');
      expect(speaker.pushed).toEqual(['弱点は火属性です。', 'ただ、耐性装備の可能性もあります。']);
      expect(memory.entries.at(-1)).toEqual({ role: '相方', text: '弱点は火属性です。ただ、耐性装備の可能性もあります。' });
    });

    it('黙ると判断した: 読み上げず、黙ったことを記録する', async () => {
      const { director, responder, speaker } = setup();
      director.onUtterance('オルダ');
      await responder.reply('スルー。');
      expect(speaker.pushed).toEqual([]);
      expect(await readLog()).toContain('（黙ると判断）');
    });

    it('答えて退去する: 合図を除いた残りだけを読み上げ、退去する', async () => {
      const { director, responder, speaker } = setup();
      director.onUtterance('オルダ、ありがとう');
      await responder.reply(`どういたしまして。${DISMISS_MARKER}`);
      expect(speaker.pushed).toEqual(['どういたしまして。']);
      expect(director.summoned).toBe(false);
    });
  });

  describe('退去する', () => {
    it('退去の合図が届く: 読み上げが終わってから消え、その後の名前のない発話では問い合わせない', async () => {
      const { director, responder, speaker, presence } = setup();
      director.onUtterance('オルダ、ありがとう');
      speaker.speaking = true;
      await responder.reply(`どういたしまして。${DISMISS_MARKER}`);
      expect(presence).toEqual([true]);
      speaker.speaking = false;
      speaker.emit('idle');
      expect(presence).toEqual([true, false]);
      director.onUtterance('さて次に行こう');
      expect(responder.ask).toHaveBeenCalledTimes(1);
      expect(await readLog()).toContain('退去しました');
    });

    it('合図だけの返事: 何も読み上げずに退去する', async () => {
      const { director, responder, speaker, presence } = setup();
      director.onUtterance('オルダ');
      await responder.reply(`スルー${DISMISS_MARKER}`);
      expect(speaker.pushed).toEqual([]);
      expect(presence).toEqual([true, false]);
    });

    it('退去の読み上げ中にもう一度呼ばれる: 消えずに召喚中のまま', async () => {
      const { director, responder, speaker, presence } = setup();
      director.onUtterance('オルダ');
      speaker.speaking = true;
      await responder.reply(`では。${DISMISS_MARKER}`);
      director.onUtterance('オルダ、待って');
      speaker.speaking = false;
      speaker.emit('idle');
      expect(director.summoned).toBe(true);
      expect(presence).toEqual([true]);
    });

    it('退去したら、問い合わせ中に届いていた発話では問い合わせない', async () => {
      const { director, responder } = setup();
      director.onUtterance('オルダ、ありがとう');
      director.onUtterance('助かった');
      await responder.reply(`どういたしまして。${DISMISS_MARKER}`);
      expect(responder.ask).toHaveBeenCalledTimes(1);
    });

    it('手で召喚と退去を切り替える', () => {
      const { director, responder, presence } = setup();
      director.toggleSummon();
      expect(director.summoned).toBe(true);
      expect(responder.ask).not.toHaveBeenCalled();
      director.toggleSummon();
      expect(director.summoned).toBe(false);
      expect(presence).toEqual([true, false]);
    });
  });

  describe('問い合わせの失敗で止まらない', () => {
    it('1 回目だけ返ってこない: 自動で 1 回やり直し、話さなくても返事を読み上げる', async () => {
      const { director, responder, speaker } = setup();
      director.onUtterance('オルダ、聞こえる?');
      responder.calls.shift().reject(new Error('タイムアウト'));
      await flush();
      expect(responder.ask).toHaveBeenCalledTimes(2);
      await responder.reply('はい、聞こえます。');
      expect(speaker.pushed).toEqual(['はい、聞こえます。']);
      expect(await readLog()).toMatch(/WARN .*問い合わせに失敗したので、もう一度問い合わせます: タイムアウト/);
    });

    it('問い合わせがエラーになる: やり直しも失敗したらエラーを記録し、何も読み上げず、次の発話で再び問い合わせる', async () => {
      const { director, responder, speaker } = setup();
      director.onUtterance('オルダ');
      responder.calls.shift().reject(new Error('503'));
      await flush();
      responder.calls.shift().reject(new Error('503'));
      await flush();
      expect(speaker.pushed).toEqual([]);
      expect(director.summoned).toBe(true);
      director.onUtterance('聞こえる?');
      expect(responder.ask).toHaveBeenCalledTimes(3);
      expect(await readLog()).toMatch(/ERROR .*問い合わせに失敗/);
    });
  });

  describe('配信者が話し始めたら黙る', () => {
    it('相方の発話中に配信者が話す（stop）: 発話が止まる', () => {
      const { director, speaker } = setup({ cfg: { bargeIn: 'stop' } });
      speaker.speaking = true;
      director.onUtterance('ちょっと待って');
      expect(speaker.stop).toHaveBeenCalled();
    });

    it('短い雑音（stop）: 1 文字では止まらない', () => {
      const { director, speaker } = setup({ cfg: { bargeIn: 'stop' } });
      speaker.speaking = true;
      director.onUtterance('あ');
      expect(speaker.stop).not.toHaveBeenCalled();
    });

    it('話しかぶせると声が小さくなる（duck）: 途中経過で 0.3 に下げ、止めない', () => {
      const { director, speaker } = setup();
      speaker.speaking = true;
      director.onInterim('ちょっと');
      expect(speaker.volumes).toEqual([0.3]);
      director.onUtterance('ちょっと待って');
      expect(speaker.stop).not.toHaveBeenCalled();
    });

    it('相方が喋っていない・1 文字だけの途中経過（duck）: 下げない', () => {
      const { director, speaker } = setup();
      director.onInterim('ちょっと');
      speaker.speaking = true;
      director.onInterim('あ');
      expect(speaker.volumes).toEqual([]);
    });

    it('話し終えると元に戻る（duck）: 発話が確定したら 1 に戻す', () => {
      const { director, speaker } = setup();
      speaker.speaking = true;
      director.onInterim('ちょっと');
      director.onUtterance('ちょっと待って');
      expect(speaker.volumes).toEqual([0.3, 1]);
    });

    it('途中経過が途切れると元に戻る（duck）: 最後の途中経過から 1,000 ミリ秒で 1 に戻す', () => {
      vi.useFakeTimers();
      const { director, speaker } = setup();
      speaker.speaking = true;
      director.onInterim('ちょっと');
      vi.advanceTimersByTime(800);
      director.onInterim('ちょっと待');
      vi.advanceTimersByTime(800);
      expect(speaker.volumes.at(-1)).toBe(0.3);
      vi.advanceTimersByTime(200);
      expect(speaker.volumes.at(-1)).toBe(1);
    });

    it('何もしない（off）: 声も発話も変わらない', () => {
      const { director, speaker } = setup({ cfg: { bargeIn: 'off' } });
      speaker.speaking = true;
      director.onInterim('ちょっと');
      director.onUtterance('ちょっと待って');
      expect(speaker.volumes).toEqual([]);
      expect(speaker.stop).not.toHaveBeenCalled();
    });
  });

  describe('一時停止中は問い合わせない', () => {
    it('一時停止中に名前を呼ぶ: 召喚も問い合わせもせず、記録はする', () => {
      const { director, responder, memory, speaker } = setup();
      director.setPaused(true);
      expect(speaker.stop).toHaveBeenCalled();
      director.onUtterance('オルダ、聞こえる?');
      director.addChat([{ author: 'Aさん', text: 'オルダ' }]);
      expect(director.summoned).toBe(false);
      expect(responder.ask).not.toHaveBeenCalled();
      expect(memory.entries).toHaveLength(2);
    });

    it('問い合わせ中に一時停止した: 届いた返事は読み上げない', async () => {
      const { director, responder, speaker } = setup();
      director.onUtterance('オルダ');
      director.setPaused(true);
      await responder.reply('はい。');
      expect(speaker.pushed).toEqual([]);
    });
  });

  describe('記録がたまったら要約する', () => {
    it('返事の後に要約の要否を確かめる', async () => {
      const { director, responder, memory } = setup();
      const spy = vi.spyOn(memory, 'maybeSummarize');
      director.onUtterance('オルダ');
      await responder.reply('はい。');
      expect(spy).toHaveBeenCalled();
    });
  });
});

describe('文に区切る', () => {
  it('区切り記号で区切り、区切り記号が連続しても 1 文、残りも 1 文', () => {
    expect(splitSentences('えっ！？本当に')).toEqual(['えっ！？', '本当に']);
    expect(splitSentences('一つ目。\n二つ目♪ ')).toEqual(['一つ目。\n', '二つ目♪']);
  });

  it('黙る合図: 前後の空白と句読点は無視し、文の一部なら合図ではない', () => {
    expect(isSilentReply('スルー。')).toBe(true);
    expect(isSilentReply(' スルー ')).toBe(true);
    expect(isSilentReply('今回はスルーしましょう。')).toBe(false);
  });
});

describe('lorebook / 進行役とのつなぎ', () => {
  const lore = () => new Lorebook({ file: path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cohost-dlore-')), 'lorebook.json'), scanEntries: 6, stickyAsks: 3, maxChars: 3000 });

  it('返事の記憶の合図: 項目を作り、合図は読み上げない', async () => {
    const lorebook = lore();
    const { director, responder, speaker } = setup({ lorebook });
    director.onUtterance('オルダ、ごつミノは一般モンスターって覚えておいて');
    await responder.reply('承知しました。【記憶: キーワード=ごつミノ、ゴツミノ ／ 内容=ごつミノは一般モンスター】');
    expect(speaker.pushed).toEqual(['承知しました。']);
    expect(lorebook.entries.map((e) => e.keys)).toEqual([['ごつミノ', 'ゴツミノ']]);
  });

  it('キーワードが出たら、その控えを問い合わせの指示に入れる', async () => {
    const lorebook = lore();
    lorebook.add({ keys: ['ごつミノ'], content: 'ごつミノは一般モンスター' });
    lorebook.add({ keys: ['ニブルヘイム'], content: '死者の国' });
    const { director, responder } = setup({ lorebook });
    director.onUtterance('オルダ、ゴツミノって強い?');
    const inst = responder.calls[0].req.instruction;
    expect(inst.startsWith('PERSONA')).toBe(true);
    expect(inst).toContain('ごつミノは一般モンスター');
    expect(inst).not.toContain('死者の国');
  });

  it('話者の区別では当たらない: 「配信者: 」の部分は探さない', () => {
    const lorebook = lore();
    lorebook.add({ keys: ['配信者'], content: '好み' });
    const { director, responder } = setup({ lorebook });
    director.onUtterance('オルダ、こんにちは');
    expect(responder.calls[0].req.instruction).not.toContain('好み');
  });

  it('チャットの投稿者名では当たる', () => {
    const lorebook = lore();
    lorebook.add({ keys: ['@AtelierDokan'], content: '常連のドカンさん' });
    const { director, responder } = setup({ lorebook });
    director.addChat([{ author: '@AtelierDokan', text: 'オルダさんこんばんは' }]);
    expect(responder.calls[0].req.instruction).toContain('常連のドカンさん');
  });

  it('退去したら、入れたままの控えを外す', async () => {
    const lorebook = lore();
    lorebook.add({ keys: ['ごつミノ'], content: 'ごつミノは一般モンスター' });
    const { director, responder } = setup({ lorebook, cfg: {} });
    director.onUtterance('オルダ、ゴツミノって強い?');
    await responder.reply(`強いです。${DISMISS_MARKER}`);
    expect(lorebook.active.size).toBe(0);
  });
});