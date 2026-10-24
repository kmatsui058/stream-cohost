import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeEach } from 'vitest';
import { Lorebook, normalize } from '../src/lorebook.js';
import { logFilePath } from '../src/log.js';

const readLog = async () => {
  await new Promise((r) => setTimeout(r, 50));
  return fs.readFileSync(logFilePath(), 'utf8');
};

describe('lorebook', () => {
  let file;
  beforeEach(() => {
    file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cohost-lore-')), 'lorebook.json');
  });
  const make = (opts = {}) => new Lorebook({ file, scanEntries: 6, stickyAsks: 3, maxChars: 3000, ...opts });
  const saved = () => JSON.parse(fs.readFileSync(file, 'utf8')).entries;

  describe('返事の合図で控えを作る', () => {
    it('覚えておくよう頼まれる: 項目を作って保存し、合図を取り除いた文を返す', async () => {
      const lb = make();
      const text = lb.apply('承知しました、覚えておきます。【記憶: キーワード=ごつミノ、ゴツミノ ／ 内容=ごつミノは一般モンスター、通常ミノがボス属性】');
      expect(text).toBe('承知しました、覚えておきます。');
      expect(saved()).toMatchObject([{ keys: ['ごつミノ', 'ゴツミノ'] }]);
      expect(saved()[0].content).toMatch(/^（\d{4}\/\d{1,2}\/\d{1,2}）ごつミノは一般モンスター、通常ミノがボス属性$/);
      expect(Date.parse(saved()[0].createdAt)).not.toBeNaN();
      expect(await readLog()).toMatch(/控えを作りました \[ごつミノ, ゴツミノ\]/);
    });

    it('既にある言葉を覚えておくよう頼まれる: 既存の内容の後ろに日付つきで書き足す', () => {
      const lb = make();
      lb.add({ keys: ['ごつミノ'], content: '（2026/10/21）凍らなくて苦戦した' });
      lb.apply('はい。【記憶: キーワード=ゴツミノ ／ 内容=一般モンスターだとドカンさんに教わった】');
      expect(lb.entries).toHaveLength(1);
      expect(lb.entries[0].content).toMatch(/^（2026\/10\/21）凍らなくて苦戦した\n（\d{4}\/\d{1,2}\/\d{1,2}）一般モンスターだとドカンさんに教わった$/);
    });

    it('1 つの返事に複数の合図: それぞれ項目にする（区切りは , や / でもよい）', () => {
      const lb = make();
      lb.apply('はい。【記憶:キーワード=A,B/内容=一つ目】【記憶: キーワード=C ／ 内容=二つ目】');
      expect(saved().map((e) => e.keys)).toEqual([['A', 'B'], ['C']]);
    });

    it('形式に合わない合図: 項目にせず警告し、合図は取り除く', async () => {
      const lb = make();
      expect(lb.apply('はい。【記憶: ごつミノは一般モンスター】')).toBe('はい。');
      expect(fs.existsSync(file)).toBe(false);
      expect(await readLog()).toMatch(/WARN .*控えの合図を読めません/);
    });
  });

  describe('返事の合図で控えを消す', () => {
    it('忘れるよう頼まれる: そのキーワードを持つ項目を消して保存する', async () => {
      const lb = make();
      lb.add({ keys: ['ごつミノ'], content: 'x' });
      lb.add({ keys: ['ドカン'], content: 'y' });
      expect(lb.apply('わかりました。【忘却: ゴツミノ】')).toBe('わかりました。');
      expect(saved().map((e) => e.keys)).toEqual([['ドカン']]);
      expect(await readLog()).toMatch(/控えを消しました \[ごつミノ\]/);
    });
  });

  describe('項目を足す・更新する', () => {
    it('キーワードが重なれば、内容を置き換えてキーワードを足す', () => {
      const lb = make();
      lb.add({ keys: ['ドカン', '@AtelierDokan'], content: '常連' });
      lb.add({ keys: ['どかん', 'ドカンさん'], content: '常連。攻略情報に詳しい' });
      expect(lb.entries).toHaveLength(1);
      expect(lb.entries[0].keys).toEqual(['ドカン', '@AtelierDokan', 'ドカンさん']);
      expect(lb.entries[0].content).toBe('常連。攻略情報に詳しい');
    });

    it('番号で消す・一覧する', () => {
      const lb = make();
      lb.add({ keys: ['A'], content: '1' });
      lb.add({ keys: ['B'], content: '2' });
      expect(lb.list()).toBe('1. [A] 1\n2. [B] 2');
      expect(lb.removeAt(1)).toBe(true);
      expect(lb.removeAt(5)).toBe(false);
      expect(saved().map((e) => e.keys)).toEqual([['B']]);
    });

    it('保存した項目を読み込む。ファイルが壊れていたら警告して空で始める', async () => {
      make().add({ keys: ['A'], content: '1' });
      const lb = make();
      lb.load();
      expect(lb.entries.map((e) => e.content)).toEqual(['1']);
      fs.writeFileSync(file, '{broken');
      const broken = make();
      broken.load();
      expect(broken.entries).toEqual([]);
      expect(await readLog()).toMatch(/WARN .*控えを読み込めません/);
    });
  });

  describe('キーワードが出たら控えを指示に入れる', () => {
    it('キーワードが出る: ひらがな・カタカナ、大文字・小文字を区別せずに当たり、内容を返す', async () => {
      const lb = make();
      lb.add({ keys: ['ごつミノ'], content: 'ごつミノは一般' });
      lb.add({ keys: ['@AtelierDokan'], content: '常連' });
      lb.add({ keys: ['ニブルヘイム'], content: '死者の国' });
      const text = lb.select('配信者: ゴツミノ強くない?\nチャット: @atelierdokan: こんばんは');
      expect(text).toContain('ごつミノは一般');
      expect(text).toContain('常連');
      expect(text).not.toContain('死者の国');
      expect(await readLog()).toMatch(/控えを入れます \[ごつミノ\], \[@AtelierDokan\]|控えを入れます \[@AtelierDokan\], \[ごつミノ\]/);
    });

    it('キーワードが出ない: 何も入れない', () => {
      const lb = make();
      lb.add({ keys: ['ごつミノ'], content: 'x' });
      expect(lb.select('配信者: こんにちは')).toBe('');
    });
  });

  describe('当たった控えはしばらく入れたままにする', () => {
    it('話題が続く: 当たった後 3 回までは入り、4 回目には入らない', () => {
      const lb = make();
      lb.add({ keys: ['ごつミノ'], content: 'x' });
      expect(lb.select('ごつミノ')).toContain('x');
      expect(lb.select('別の話 1')).toContain('x');
      expect(lb.select('別の話 2')).toContain('x');
      expect(lb.select('別の話 3')).toContain('x');
      expect(lb.select('別の話 4')).toBe('');
    });

    it('退去する: 入れたままの項目を外す', () => {
      const lb = make();
      lb.add({ keys: ['ごつミノ'], content: 'x' });
      lb.select('ごつミノ');
      lb.reset();
      expect(lb.select('別の話')).toBe('');
    });
  });

  describe('入れる量の上限', () => {
    it('上限を超える: 最近当たったものを優先し、入らなかったことを記録する', async () => {
      const lb = make({ maxChars: 10, stickyAsks: 3 });
      lb.add({ keys: ['古い'], content: 'あいうえおかきく' }); // 8 字
      lb.add({ keys: ['新しい'], content: 'さしすせそたち' }); // 7 字
      lb.select('古い');
      const text = lb.select('新しい');
      expect(text).toContain('さしすせそたち');
      expect(text).not.toContain('あいうえお');
      expect(await readLog()).toMatch(/上限 10 字を超えるので入れなかった控え: \[古い\]/);
    });
  });

  it('normalize: ひらがなをカタカナに、全角英数を半角に、英字を小文字にそろえる', () => {
    expect(normalize('おるだ ＡＢＣ abc')).toBe('オルダ abc abc');
  });
});
