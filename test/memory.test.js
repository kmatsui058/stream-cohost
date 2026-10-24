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
      expect(prompt).toMatch(/捨てるもの[\s\S]*相づち[\s\S]*挨拶の繰り返し[\s\S]*言い淀み/);
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
      expect(inst).toMatch(/# ここまでの配信の要約\n- ボス戦中/);
      expect(inst).not.toContain('がんばれ');
      expect(mem.transcript()).toBe('チャット: Aさん: がんばれ\nチャット: Bさん: 草');
    });
  });

  describe('記憶を保存する', () => {
    const makeWithState = (ai, recentEntries = 1) => {
      const stateFile = path.join(path.dirname(summaryFile), 'carryover.json');
      return { mem: new Memory({ ai, model: 'm', maxChars: 1500, recentEntries, persona: 'PERSONA', summaryFile, stateFile }), stateFile };
    };

    it('要約を更新するたびに保存する', async () => {
      const { mem, stateFile } = makeWithState(fakeAi('一回目の要約'));
      fill(mem, 3);
      await mem.summarize();
      const s = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
      expect(s.summary).toBe('一回目の要約');
      expect(s.recent).toEqual([{ role: '配信者', text: '発言2' }]);
      expect(Date.parse(s.savedAt)).not.toBeNaN();
    });

    it('終了する: 要約を更新してから保存する', async () => {
      const ai = fakeAi('最終の要約');
      const { mem, stateFile } = makeWithState(ai);
      fill(mem, 3);
      await mem.finalize();
      expect(ai.models.generateContent).toHaveBeenCalledTimes(1);
      expect(JSON.parse(fs.readFileSync(stateFile, 'utf8')).summary).toBe('最終の要約');
    });

    it('終了時に要約が失敗する: それまでの要約と発言をそのまま保存する', async () => {
      const ai = { models: { generateContent: vi.fn().mockRejectedValue(new Error('503')) } };
      const { mem, stateFile } = makeWithState(ai);
      mem.summary = 'それまでの要約';
      fill(mem, 3);
      await mem.finalize();
      const s = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
      expect(s.summary).toBe('それまでの要約');
      expect(s.recent).toHaveLength(3);
    });

    it('終了時の要約が 8 秒以内に終わらない: その時点の内容を保存する', async () => {
      vi.useFakeTimers();
      try {
        const ai = { models: { generateContent: vi.fn(() => new Promise(() => {})) } };
        const { mem, stateFile } = makeWithState(ai);
        fill(mem, 3);
        const p = mem.finalize();
        await vi.advanceTimersByTimeAsync(8000);
        await p;
        expect(JSON.parse(fs.readFileSync(stateFile, 'utf8')).recent).toHaveLength(3);
      } finally {
        vi.useRealTimers();
      }
    });

    it('何も話していなければ、要約も保存もしない', async () => {
      const ai = fakeAi();
      const { mem, stateFile } = makeWithState(ai);
      await mem.finalize();
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

    it('前回の記憶がある: 指示のペルソナの後ろに、前回の要約と直近の発言を入れる', () => {
      const mem = stateIn(JSON.stringify({ savedAt: '2026-10-17T13:00:00.000Z', summary: '- 転生クエスト中', recent: [{ role: '配信者', text: 'また明日' }] }));
      expect(mem.loadPrevious()).toBe(true);
      const inst = mem.instruction();
      expect(inst.indexOf('PERSONA')).toBe(0);
      expect(inst).toMatch(/# 前回の配信の要約/);
      expect(inst).toContain('- 転生クエスト中');
      expect(inst).toContain('配信者: また明日');
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
    it('要約が更新された: ファイルを最新の内容と時刻で上書きし、ログにも記録する', async () => {
      const mem = make(fakeAi('一回目'), 0);
      fill(mem, 1);
      await mem.summarize();
      mem.ai = fakeAi('二回目');
      fill(mem, 1);
      await mem.summarize();
      const file = fs.readFileSync(summaryFile, 'utf8');
      expect(file).toMatch(/^# \d{4}\/\d{1,2}\/\d{1,2} /);
      expect(file).toContain('二回目');
      expect(file).not.toContain('一回目');
      await new Promise((r) => setTimeout(r, 50));
      expect(fs.readFileSync(logFilePath(), 'utf8')).toContain('要約を更新');
    });
  });
});
