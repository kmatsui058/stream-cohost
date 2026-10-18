import fs from 'node:fs';
import { describe, it, expect } from 'vitest';
import { checkReply, summarize, CHECKS } from '../eval/checks.js';

describe('prompt-eval / 返事をルールでチェックする', () => {
  it('サポート口調の返事: サポート口調と、疑問で終わることを記録する', () => {
    const r = checkReply('了解しました。準備はよろしいですか。');
    expect(r.support).toBe(true);
    expect(r.question).toBe(true);
  });

  it('誤った呼び方: 「小波さん」を記録する。「オコハ」は誤りにしない', () => {
    expect(checkReply('小波さんはどう思いますか。').wrongName).toBe(true);
    expect(checkReply('夕暮れ小波さん、失礼しました。').wrongName).toBe(true);
    expect(checkReply('オコハは、どう考えますか。').wrongName).toBe(false);
  });

  it('長さ・「ですね」・共感の定型句・自己言及を記録する', () => {
    const long = 'あ'.repeat(71);
    expect(checkReply(long).long).toBe(true);
    expect(checkReply('あ'.repeat(70)).long).toBe(false);
    expect(checkReply('いよいよですね。').desuNe).toBe(true);
    expect(checkReply('次はどんな発見があるか楽しみです。').empathy).toBe(true);
    expect(checkReply('言葉の番人として、お詫びします。').selfRef).toBe(true);
  });

  it('問題のない返事は何も記録しない', () => {
    const r = checkReply('三度とも、壁際で倒れています。');
    expect(CHECKS.filter((c) => r[c.key])).toEqual([]);
  });

  it('空の返事は失敗として扱う', () => {
    expect(checkReply('').empty).toBe(true);
  });

  it('集計: 項目ごとに該当した返事の数を数える', () => {
    const s = summarize([checkReply('了解しました。'), checkReply('いよいよですね。'), checkReply('いよいよですね?')]);
    expect(s.support).toBe(1);
    expect(s.desuNe).toBe(2);
    expect(s.question).toBe(1);
    expect(s.total).toBe(3);
  });
});

describe('prompt-eval / 評価ケース', () => {
  it('ケースのファイルを読み込める（id・種類・入力がそろっている）', () => {
    const cases = JSON.parse(fs.readFileSync('eval/cases.json', 'utf8'));
    expect(cases.length).toBeGreaterThanOrEqual(15);
    for (const c of cases) {
      expect(c.id).toMatch(/^[a-z0-9-]+$/);
      expect(['user', 'idle', 'chat']).toContain(c.type);
      if (c.type === 'idle') expect(Number.isInteger(c.topic)).toBe(true);
      else expect(c.text.length).toBeGreaterThan(0);
    }
    expect(new Set(cases.map((c) => c.id)).size).toBe(cases.length);
  });
});
