import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeEach } from 'vitest';
import { Policies } from '../src/policies.js';
import { logFilePath } from '../src/log.js';

const readLog = async () => {
  await new Promise((r) => setTimeout(r, 30));
  return fs.readFileSync(logFilePath(), 'utf8');
};

describe('policies', () => {
  let file;
  beforeEach(() => {
    file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cohost-policy-')), 'policies.json');
  });
  const make = (maxChars = 1000) => new Policies({ file, maxChars });
  const saved = () => JSON.parse(fs.readFileSync(file, 'utf8')).policies;

  describe('返事の合図で方針を足す', () => {
    it('方針を伝えられる: 保存して、合図を取り除いた文を返す', async () => {
      const p = make();
      expect(p.apply('承知しました。【方針: 攻略の手順やヒントは、はっきり聞かれたときだけ答える】')).toBe('承知しました。');
      expect(saved()).toMatchObject([{ text: '攻略の手順やヒントは、はっきり聞かれたときだけ答える' }]);
      expect(Date.parse(saved()[0].createdAt)).not.toBeNaN();
      expect(await readLog()).toMatch(/方針を足しました: 攻略の手順やヒント/);
    });

    it('同じ内容の方針は重ねて保存しない', () => {
      const p = make();
      p.apply('【方針: 攻略は聞かれたときだけ】');
      p.apply('はい。【方針：攻略は聞かれたときだけ】');
      expect(saved()).toHaveLength(1);
    });
  });

  describe('方針を毎回入れる', () => {
    it('起動して問い合わせる: 読み込んだ方針を「マスターの方針」として返す', () => {
      const first = make();
      first.add('攻略は聞かれたときだけ');
      first.add('人間的なやり取りをしてほしい');
      const p = make();
      p.load();
      expect(p.section()).toBe('# マスターの方針（いつも守ること）\n- 攻略は聞かれたときだけ\n- 人間的なやり取りをしてほしい');
    });

    it('方針がなければ何も返さない。ファイルが壊れていたら警告して空で始める', async () => {
      expect(make().section()).toBe('');
      fs.writeFileSync(file, '{broken');
      const p = make();
      p.load();
      expect(p.section()).toBe('');
      expect(await readLog()).toMatch(/WARN .*方針を読み込めません/);
    });

    it('上限を超える: 新しいものを優先して入れ、入らなかったことを記録する', async () => {
      const p = make(10);
      p.add('あいうえおかきく'); // 8 字（古い）
      p.add('さしすせそ'); // 5 字（新しい）
      const s = p.section();
      expect(s).toContain('さしすせそ');
      expect(s).not.toContain('あいうえお');
      expect(await readLog()).toMatch(/上限 10 字を超えるので入れなかった方針: あいうえおかきく/);
    });
  });

  it('番号で一覧・消す', () => {
    const p = make();
    p.add('一つ目');
    p.add('二つ目');
    expect(p.list()).toBe('1. 一つ目\n2. 二つ目');
    expect(p.removeAt(1)).toBe(true);
    expect(p.removeAt(9)).toBe(false);
    expect(saved().map((x) => x.text)).toEqual(['二つ目']);
  });
});
