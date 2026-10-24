import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Memory } from '../src/memory.js';
import { logFilePath } from '../src/log.js';

function fakeAi(reply = '- ゲーム実況中。ボス戦で3回負けた') {
  return { models: { generateContent: vi.fn(async () => ({ text: reply })) } };
}

describe('conversation-memory', () => {
  let summaryFile;
  beforeEach(() => {
    summaryFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cohost-mem-')), 'summary.txt');
  });
  const make = (ai, recentEntries = 12, summarizeAtChars = 12000) =>
    new Memory({ ai, model: 'flash', maxChars: 4000, recentEntries, summarizeAtChars, persona: 'PERSONA', summaryFile, stateFile: path.join(path.dirname(summaryFile), 'state.json') });
  const fill = (mem, n) => {
    for (let i = 0; i < n; i++) mem.add(i % 2 ? '相方' : '配信者', `発言${i}`);
  };

  describe('発言を 1 件ずつ記録する', () => {
    it('発話と返事: 同じ話者が続いても 1 件ずつ、この順に記録される', () => {
      const mem = make(fakeAi());
      mem.add('配信者', 'ボス');
      mem.add('配信者', '強すぎ');
      mem.add('相方', 'もう3回目ですね。');
      expect(mem.entries.map(({ role, text }) => ({ role, text }))).toEqual([
        { role: '配信者', text: 'ボス' },
        { role: '配信者', text: '強すぎ' },
        { role: '相方', text: 'もう3回目ですね。' },
      ]);
    });

    it('連続するチャット: 別々に記録される', () => {
      const mem = make(fakeAi());
      mem.add('チャット', 'Aさん: がんばれ');
      mem.add('チャット', 'Bさん: 草');
      expect(mem.entries).toHaveLength(2);
    });

    it('空の文字起こしは記録しない', () => {
      const mem = make(fakeAi());
      mem.add('配信者', '');
      expect(mem.entries).toHaveLength(0);
    });
  });

  describe('直近を残して古い発言を要約する', () => {
    it('発言が直近の件数より多い: 古い 2 件と前回の要約から要約し、直近 12 件を残す', async () => {
      const ai = fakeAi('新しい要約');
      const mem = make(ai);
      mem.summary = '前回の要約';
      fill(mem, 14);
      await mem.summarize();
      const prompt = ai.models.generateContent.mock.calls[0][0].contents;
      expect(ai.models.generateContent.mock.calls[0][0].model).toBe('flash');
      expect(prompt).toContain('前回の要約');
      expect(prompt).toContain('配信者: 発言0\n相方: 発言1');
      expect(prompt).not.toContain('発言2');
      expect(mem.entries).toHaveLength(12);
      expect(mem.entries[0].text).toBe('発言2');
      expect(mem.summary).toBe('新しい要約');
    });

    it('発言が直近の件数以下: 要約しない', async () => {
      const ai = fakeAi();
      const mem = make(ai);
      fill(mem, 12);
      await mem.summarize();
      expect(ai.models.generateContent).not.toHaveBeenCalled();
      expect(mem.entries).toHaveLength(12);
    });

    it.each([0, 12])('要約中に新しい発言が届く（直近 %i 件）: 完了後も残っている', async (recent) => {
      let release;
      const ai = { models: { generateContent: vi.fn(() => new Promise((r) => (release = r))) } };
      const mem = make(ai, recent);
      fill(mem, 14); // 最後は「相方: 発言13」
      const p = mem.summarize();
      mem.add('相方', '（続き）');
      mem.add('配信者', '新しい話');
      release({ text: '要約' });
      await p;
      const texts = mem.entries.map((e) => e.text);
      expect(texts).toContain('新しい話');
      expect(texts.join()).toContain('（続き）');
    });
  });

  describe('要約の作り方', () => {
    it('要約を求める: 設定したモデルに、文字数の上限と、残すもの・捨てるものを指示する', async () => {
      const ai = fakeAi();
      const mem = make(ai, 0);
      fill(mem, 1);
      await mem.summarize();
      const prompt = ai.models.generateContent.mock.calls[0][0].contents;
      expect(ai.models.generateContent.mock.calls[0][0].model).toBe('flash');
      expect(prompt).toContain('4000 文字以内');
      expect(prompt).toMatch(/残すもの[\s\S]*今やっていること[\s\S]*物語やセリフの要点[\s\S]*事実・好み・予定・感想[\s\S]*訂正[\s\S]*相方[\s\S]*常連/);
      expect(prompt).toMatch(/捨てるもの[\s\S]*相づち[\s\S]*挨拶の繰り返し[\s\S]*言い淀み[\s\S]*動作確認/);
      expect(prompt).toContain('（なし）');
    });

    it('すでに与えている情報は繰り返さない: ペルソナと今日の配信の情報を添えて、繰り返さないよう指示する', async () => {
      const ai = fakeAi();
      const mem = make(ai, 0);
      mem.setStreamInfo({ title: '【RO】EP追想#6', description: '' });
      fill(mem, 1);
      await mem.summarize();
      const prompt = ai.models.generateContent.mock.calls[0][0].contents;
      expect(prompt).toMatch(/# すでに与えている情報[\s\S]*PERSONA[\s\S]*【RO】EP追想#6/);
      expect(prompt).toMatch(/すでに与えている情報.*繰り返さない/);
    });

    it('前回の振り返りだけの回: これまでの配信の要約を添え、振り返りを今回の出来事として残さないよう指示する', async () => {
      const ai = fakeAi();
      const mem = make(ai, 0);
      mem.longSummary = '- 10/21: The Sign を授与された';
      mem.add('配信者', '前回のお話の要約を教えてくれる？');
      mem.add('相方', '前回は The Sign を授与されました。');
      await mem.summarize();
      const prompt = ai.models.generateContent.mock.calls[0][0].contents;
      expect(prompt).toMatch(/# すでに与えている情報[\s\S]*これまでの配信の要約[\s\S]*- 10\/21: The Sign を授与された[\s\S]*# これまでの要約/);
      expect(prompt).toMatch(/過去の配信を振り返って話しただけの内容は、今回の出来事として残さない/);
    });

    it('要約が空で返った: 失敗とし、記録と前回の要約を変えない', async () => {
      const mem = make(fakeAi('  '), 0);
      mem.summary = '前回';
      fill(mem, 3);
      await expect(mem.summarize()).rejects.toThrow(/空/);
      expect(mem.summary).toBe('前回');
      expect(mem.entries).toHaveLength(3);
    });

    it('API がエラー: 失敗を伝え、記録を変えない', async () => {
      const ai = { models: { generateContent: vi.fn().mockRejectedValue(new Error('503')) } };
      const mem = make(ai, 0);
      fill(mem, 2);
      await expect(mem.summarize()).rejects.toThrow('503');
      expect(mem.entries).toHaveLength(2);
    });
  });

  describe('要約を重ねて実行しない', () => {
    it('要約中に再度求められる: 1 回だけ実行し、両方が完了を受け取る', async () => {
      let release;
      const ai = { models: { generateContent: vi.fn(() => new Promise((r) => (release = r))) } };
      const mem = make(ai, 0);
      fill(mem, 2);
      const a = mem.summarize();
      const b = mem.summarize();
      expect(b).toBe(a);
      release({ text: '要約' });
      await Promise.all([a, b]);
      expect(ai.models.generateContent).toHaveBeenCalledTimes(1);
    });
  });

  describe('たまったら要約する', () => {
    it('記録が 12,000 文字を超える: 要約を 1 回作る（作成中に重ねて作らない）', async () => {
      const ai = fakeAi('要約');
      const mem = make(ai, 0, 100);
      mem.add('配信者', 'あ'.repeat(60));
      mem.maybeSummarize();
      expect(ai.models.generateContent).not.toHaveBeenCalled();
      mem.add('配信者', 'い'.repeat(60));
      mem.maybeSummarize();
      mem.maybeSummarize();
      await mem.summarizing;
      expect(ai.models.generateContent).toHaveBeenCalledTimes(1);
      expect(mem.entries).toHaveLength(0);
    });

    it('記録が少ない: 要約しない', () => {
      const ai = fakeAi();
      const mem = make(ai, 0);
      fill(mem, 20);
      mem.maybeSummarize();
      expect(ai.models.generateContent).not.toHaveBeenCalled();
    });

    it('要約に失敗しても例外を投げず、警告を記録する', async () => {
      const ai = { models: { generateContent: vi.fn().mockRejectedValue(new Error('503')) } };
      const mem = make(ai, 0, 1);
      fill(mem, 2);
      mem.maybeSummarize();
      await new Promise((r) => setTimeout(r, 50));
      expect(fs.readFileSync(logFilePath(), 'utf8')).toMatch(/WARN .*要約に失敗/);
    });
  });

  describe('問い合わせの材料を組み立てる', () => {
    it('配信開始直後: 指示はペルソナだけ、記録は空', () => {
      const mem = make(fakeAi());
      expect(mem.instruction()).toBe('PERSONA');
      expect(mem.transcript()).toBe('');
    });

    it('要約と記録がある: 指示はペルソナ → 要約、記録は要約以降の発言を「話者: 発言」で並べる', async () => {
      const mem = make(fakeAi('- ボス戦中'), 2);
      mem.add('配信者', '古い話');
      mem.add('チャット', 'Aさん: がんばれ');
      mem.add('チャット', 'Bさん: 草');
      await mem.summarize();
      const inst = mem.instruction();
      expect(inst.indexOf('PERSONA')).toBe(0);
      expect(inst).toMatch(/# 今回のここまでの要約\n- ボス戦中/);
      expect(inst).not.toContain('がんばれ');
      expect(mem.transcript()).toBe('チャット: Aさん: がんばれ\nチャット: Bさん: 草');
    });
  });

  describe('記憶を保存する・配信をまたいで要約を積み上げる', () => {
    let dir, stateFile, sessionsDir;
    beforeEach(() => {
      dir = path.dirname(summaryFile);
      stateFile = path.join(dir, 'carryover.json');
      sessionsDir = path.join(dir, 'sessions');
    });
    // 要約・まとめ直しの呼び出しを、プロンプトの中身で返し分ける偽物
    const scriptedAi = ({ session = '- 今回はニブルヘイムを進めた', merged = '# 累積\n- 10/18 と 10/21 と今回', failMerge = false } = {}) => ({
      models: {
        generateContent: vi.fn(async ({ contents }) => {
          if (contents.includes('これまでの配信の要約」を更新')) {
            if (failMerge) throw new Error('503');
            return { text: merged };
          }
          return { text: session };
        }),
      },
    });
    const makeMem = (ai) => new Memory({ ai, model: 'm', maxChars: 4000, longMaxChars: 20000, recentEntries: 1, persona: 'PERSONA', summaryFile, stateFile });
    const state = () => JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    const writeState = (s) => fs.writeFileSync(stateFile, JSON.stringify(s));

    it('配信中に要約を更新する: 累積の要約は変えず、今回の要約と直近の発言を保存する', async () => {
      writeState({ savedAt: '2026-10-21T13:00:00.000Z', longSummary: '累積', pending: [], recent: [] });
      const mem = makeMem(scriptedAi());
      mem.loadPrevious();
      fill(mem, 3);
      await mem.summarize();
      const s = state();
      expect(s.longSummary).toBe('累積');
      expect(s.pending.map((p) => p.summary)).toEqual(['- 今回はニブルヘイムを進めた']);
      expect(s.recent).toEqual([{ role: '配信者', text: '発言2' }]);
      expect(Date.parse(s.savedAt)).not.toBeNaN();
    });

    it('配信を終える: 今回分を要約し、累積の要約とまとめ直して保存し、今回の要約を履歴に残す', async () => {
      writeState({ savedAt: '2026-10-21T13:00:00.000Z', longSummary: '- 10/18: グラストヘイム\n- 10/21: ニブルヘイム到着', pending: [], recent: [] });
      const ai = scriptedAi();
      const mem = makeMem(ai);
      mem.loadPrevious();
      fill(mem, 3);
      await mem.finalize();
      const prompts = ai.models.generateContent.mock.calls.map((c) => c[0].contents);
      const merge = prompts.find((p) => p.includes('これまでの配信の要約」を更新'));
      expect(merge).toContain('20000 文字以内');
      expect(merge).toContain('- 10/18: グラストヘイム');
      expect(merge).toContain('- 今回はニブルヘイムを進めた');
      expect(merge).toMatch(/古い配信ほど要点/);
      expect(merge).toMatch(/動作確認/);
      expect(merge).toMatch(/書かれていない出来事を作らない/);
      expect(merge).toMatch(/新しい出来事のない回には見出しを立てない/);
      const s = state();
      expect(s.longSummary).toBe('# 累積\n- 10/18 と 10/21 と今回');
      expect(s.pending).toEqual([]);
      expect(s.recent).toEqual([{ role: '配信者', text: '発言2' }]);
      const history = fs.readdirSync(sessionsDir);
      expect(history).toHaveLength(1);
      expect(fs.readFileSync(path.join(sessionsDir, history[0]), 'utf8')).toContain('- 今回はニブルヘイムを進めた');
    });

    it('短い配信（要約が一度も走っていない）でも、終了時に全部を要約してまとめ直す', async () => {
      const ai = scriptedAi();
      const mem = makeMem(ai);
      mem.add('配信者', '短い配信');
      await mem.finalize();
      expect(state().longSummary).toBe('# 累積\n- 10/18 と 10/21 と今回');
      expect(state().recent).toEqual([{ role: '配信者', text: '短い配信' }]);
    });

    it('動作確認だけのセッションを終える: 累積の要約、前回の要約と直近の発言はそのまま残る', async () => {
      const before = { savedAt: '2026-10-21T13:00:00.000Z', longSummary: '累積', pending: [{ at: '2026-10-21T13:00:00.000Z', summary: '前回' }], recent: [{ role: '配信者', text: 'また明日' }] };
      writeState(before);
      const ai = scriptedAi({ session: '（なし）' });
      const mem = makeMem(ai);
      mem.loadPrevious();
      mem.add('配信者', 'オルダ、聞こえる?');
      mem.add('相方', 'はい。');
      await mem.finalize();
      const s = state();
      expect(s.longSummary).toBe('累積');
      expect(s.pending).toEqual(before.pending);
      expect(s.recent).toEqual(before.recent);
      expect(fs.existsSync(sessionsDir)).toBe(false);
    });

    it('まとめ直しに失敗する: 累積の要約は変えず、今回の要約をまとめ直していないものとして保存する', async () => {
      writeState({ savedAt: '2026-10-21T13:00:00.000Z', longSummary: '累積', pending: [], recent: [] });
      const mem = makeMem(scriptedAi({ failMerge: true }));
      mem.loadPrevious();
      fill(mem, 3);
      await mem.finalize();
      const s = state();
      expect(s.longSummary).toBe('累積');
      expect(s.pending.map((p) => p.summary)).toEqual(['- 今回はニブルヘイムを進めた']);
    });

    it('前回まとめ直せなかった要約がある: 累積・前回・今回の 3 つからまとめ直す', async () => {
      writeState({ savedAt: '2026-10-21T13:00:00.000Z', longSummary: '累積', pending: [{ at: '2026-10-21T13:00:00.000Z', summary: '前回まとめ損ねた要約' }], recent: [] });
      const ai = scriptedAi();
      const mem = makeMem(ai);
      mem.loadPrevious();
      fill(mem, 3);
      await mem.finalize();
      const merge = ai.models.generateContent.mock.calls.map((c) => c[0].contents).find((p) => p.includes('これまでの配信の要約」を更新'));
      expect(merge).toContain('累積');
      expect(merge).toContain('前回まとめ損ねた要約');
      expect(merge).toContain('- 今回はニブルヘイムを進めた');
      expect(state().pending).toEqual([]);
    });

    it('終了時に要約が失敗する: それまでの要約と発言をそのまま保存する', async () => {
      const ai = { models: { generateContent: vi.fn().mockRejectedValue(new Error('503')) } };
      const mem = makeMem(ai);
      mem.summary = 'それまでの要約';
      fill(mem, 3);
      await mem.finalize();
      const s = state();
      expect(s.pending.map((p) => p.summary)).toEqual(['それまでの要約']);
      expect(s.recent).toHaveLength(1);
    });

    it('終了時の要約が 8 秒以内に終わらない: その時点の内容を保存する', async () => {
      vi.useFakeTimers();
      try {
        const ai = { models: { generateContent: vi.fn(() => new Promise(() => {})) } };
        const mem = makeMem(ai);
        mem.summary = '途中の要約';
        fill(mem, 3);
        const p = mem.finalize();
        await vi.advanceTimersByTimeAsync(8000 + 60000); // 要約 8 秒 + まとめ直し 60 秒で諦める
        await p;
        expect(state().pending.map((x) => x.summary)).toEqual(['途中の要約']);
      } finally {
        vi.useRealTimers();
      }
    });

    it('何も話していなければ、要約も保存もしない', async () => {
      const ai = scriptedAi();
      await makeMem(ai).finalize();
      expect(ai.models.generateContent).not.toHaveBeenCalled();
      expect(fs.existsSync(stateFile)).toBe(false);
    });
  });

  describe('前回の記憶を読み込む', () => {
    const stateIn = (content) => {
      const stateFile = path.join(path.dirname(summaryFile), 'carryover.json');
      if (content !== undefined) fs.writeFileSync(stateFile, content);
      return new Memory({ ai: fakeAi(), model: 'm', maxChars: 1500, recentEntries: 12, persona: 'PERSONA', summaryFile, stateFile });
    };

    it('前回の記憶がある: 指示のペルソナの後ろに、累積の要約・まとめ直していない要約・直近の発言を入れる', () => {
      const mem = stateIn(JSON.stringify({
        savedAt: '2026-10-21T13:00:00.000Z',
        longSummary: '- 転生クエスト中',
        pending: [{ at: '2026-10-21T13:00:00.000Z', summary: '- まとめ損ねた回' }],
        recent: [{ role: '配信者', text: 'また明日' }],
      }));
      expect(mem.loadPrevious()).toBe(true);
      const inst = mem.instruction();
      expect(inst.indexOf('PERSONA')).toBe(0);
      expect(inst).toMatch(/# これまでの配信の要約/);
      expect(inst).toContain('- 転生クエスト中');
      expect(inst).toContain('- まとめ損ねた回');
      expect(inst).toContain('配信者: また明日');
    });

    it('以前の形式のファイル: その要約を累積の要約として読む', () => {
      const mem = stateIn(JSON.stringify({ savedAt: '2026-10-17T13:00:00.000Z', summary: '- 以前の形式', recent: [{ role: '配信者', text: 'また明日' }] }));
      expect(mem.loadPrevious()).toBe(true);
      expect(mem.longSummary).toBe('- 以前の形式');
      expect(mem.instruction()).toContain('- 以前の形式');
    });

    it('保存された内容が壊れている: 警告して、ペルソナだけで起動する', async () => {
      const mem = stateIn('{broken');
      expect(mem.loadPrevious()).toBe(false);
      expect(mem.instruction()).toBe('PERSONA');
      await new Promise((r) => setTimeout(r, 50));
      expect(fs.readFileSync(logFilePath(), 'utf8')).toMatch(/WARN .*前回の記憶を読み込めません/);
    });

    it('保存がなければ何もしない', () => {
      const mem = stateIn(undefined);
      expect(mem.loadPrevious()).toBe(false);
      expect(mem.instruction()).toBe('PERSONA');
    });
  });

  describe('stream-info / 配信の情報を指示に入れる', () => {
    it('タイトルと概要欄がある: ペルソナの後ろに「今日の配信」として入れる', () => {
      const mem = make(fakeAi());
      expect(mem.setStreamInfo({ title: '【RO】EP追想#5', description: '今日は転生します' })).toBe(true);
      const inst = mem.instruction();
      expect(inst.indexOf('PERSONA')).toBe(0);
      expect(inst).toMatch(/# 今日の配信\nタイトル: 【RO】EP追想#5\n概要欄:\n今日は転生します/);
    });

    it('概要欄が長い: 先頭の 1,000 文字までを入れる', () => {
      const mem = make(fakeAi());
      mem.setStreamInfo({ title: 't', description: 'あ'.repeat(1000) + 'い'.repeat(2000) });
      const inst = mem.instruction();
      expect(inst).toContain('あ'.repeat(1000));
      expect(inst).not.toContain('い');
    });

    it('配信の情報がなければ入れない。同じ情報をもう一度渡すと「変化なし」を返す', () => {
      const mem = make(fakeAi());
      expect(mem.instruction()).toBe('PERSONA');
      mem.setStreamInfo({ title: 't', description: 'd' });
      expect(mem.setStreamInfo({ title: 't', description: 'd' })).toBe(false);
      expect(mem.setStreamInfo({ title: 't2', description: 'd' })).toBe(true);
    });
  });

  describe('要約を確認できるようにする', () => {
    it('要約が更新された: ログに要約の内容を記録し、要約だけのファイルは作らない', async () => {
      const mem = make(fakeAi('二回目の要約の中身'), 0);
      fill(mem, 1);
      await mem.summarize();
      expect(fs.existsSync(summaryFile)).toBe(false);
      await new Promise((r) => setTimeout(r, 50));
      expect(fs.readFileSync(logFilePath(), 'utf8')).toMatch(/要約を更新[^\n]*\n二回目の要約の中身/);
    });
  });
});
