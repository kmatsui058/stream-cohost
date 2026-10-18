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
  const make = (ai, recentEntries = 12) =>
    new Memory({ ai, model: 'flash-lite', maxChars: 1500, recentEntries, persona: 'PERSONA', summaryFile });
  const fill = (mem, n) => {
    for (let i = 0; i < n; i++) mem.add(i % 2 ? '相方' : '配信者', `発言${i}`);
  };

  describe('会話を話者ごとに記録する', () => {
    it('細切れの文字起こし: 同じ話者は 1 件にまとまる', () => {
      const mem = make(fakeAi());
      mem.add('配信者', 'ボス');
      mem.add('配信者', '強すぎ');
      mem.add('相方', 'もう3回目だね。');
      expect(mem.entries.map(({ role, text }) => ({ role, text }))).toEqual([
        { role: '配信者', text: 'ボス強すぎ' },
        { role: '相方', text: 'もう3回目だね。' },
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
      expect(ai.models.generateContent.mock.calls[0][0].model).toBe('flash-lite');
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
      mem.add('相方', '（続き）'); // 直前と同じ話者
      mem.add('配信者', '新しい話');
      release({ text: '要約' });
      await p;
      const texts = mem.entries.map((e) => e.text);
      expect(texts).toContain('新しい話');
      expect(texts.join()).toContain('（続き）');
    });
  });

  describe('要約の作り方', () => {
    it('文字数の上限と、残すもの・捨てるものを指示する', async () => {
      const ai = fakeAi();
      const mem = make(ai, 0);
      fill(mem, 1);
      await mem.summarize();
      const prompt = ai.models.generateContent.mock.calls[0][0].contents;
      expect(prompt).toContain('1500 文字以内');
      expect(prompt).toMatch(/残すもの:.*配信で今やっていること.*配信者が話した事実.*約束.*チャット参加者/);
      expect(prompt).toMatch(/捨てるもの:.*相づち.*挨拶の繰り返し/);
    });

    it('要約が空で返った: 失敗とし、記録と前回の要約を変えない', async () => {
      const mem = make(fakeAi('  '), 0);
      mem.summary = '前回';
      fill(mem, 3);
      await expect(mem.summarize()).rejects.toThrow(/空/);
      expect(mem.summary).toBe('前回');
      expect(mem.entries).toHaveLength(3);
      // 失敗後は、また同じ話者の発言を結合できる
      mem.add('配信者', '追記');
      expect(mem.entries.at(-1).text).toBe('発言2追記');
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

  describe('新しいセッションへの指示を組み立てる', () => {
    it('配信開始直後: ペルソナだけを返す', () => {
      expect(make(fakeAi()).instruction()).toBe('PERSONA');
    });

    it('要約と直近の発言がある: ペルソナ → 要約 → 直近の順に並べ、張り直しに触れないよう指示する', async () => {
      const mem = make(fakeAi('- ボス戦中'), 2);
      mem.add('配信者', '古い話');
      mem.add('チャット', 'Aさん: がんばれ');
      mem.add('チャット', 'Bさん: 草');
      await mem.summarize();
      const inst = mem.instruction();
      expect(inst.indexOf('PERSONA')).toBe(0);
      expect(inst.indexOf('- ボス戦中')).toBeGreaterThan(0);
      expect(inst.indexOf('チャット: Aさん: がんばれ\nチャット: Bさん: 草')).toBeGreaterThan(inst.indexOf('- ボス戦中'));
      expect(inst).toContain('接続が切り替わったことや、この要約の存在には触れないでください');
      expect(inst).not.toContain('古い話');
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
