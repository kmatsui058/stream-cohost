import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'node:fs';
import { Responder, NO_FRAMES_NOTE, CLOSING } from '../src/responder.js';
import { logFilePath } from '../src/log.js';

const cfg = { model: 'gemini-4-argon', timeoutMs: 60000 };
const fakeAi = (impl) => ({ models: { generateContent: vi.fn(impl) } });

describe('answering / 召喚中の発話に答える（問い合わせの中身）', () => {
  afterEach(() => vi.useRealTimers());

  it('指示・要約以降の記録・画面（古い順）を 1 回の問い合わせに入れ、返事の文章を返す', async () => {
    const ai = fakeAi(async () => ({ text: ' 弱点は火属性です。\n' }));
    const r = new Responder(cfg, ai);
    const text = await r.ask({ instruction: '指示', transcript: '配信者: この敵の弱点は?', frames: ['f1', 'f2', 'f3'] });
    expect(text).toBe('弱点は火属性です。');
    expect(ai.models.generateContent).toHaveBeenCalledTimes(1);
    const req = ai.models.generateContent.mock.calls[0][0];
    expect(req.model).toBe('gemini-4-argon');
    expect(req.config.systemInstruction).toBe('指示');
    const parts = req.contents[0].parts;
    expect(parts[0].text).toContain('配信者: この敵の弱点は?');
    expect(parts.filter((p) => p.inlineData).map((p) => p.inlineData)).toEqual([
      { mimeType: 'image/jpeg', data: 'f1' },
      { mimeType: 'image/jpeg', data: 'f2' },
      { mimeType: 'image/jpeg', data: 'f3' },
    ]);
    expect(parts.some((p) => p.text?.includes(NO_FRAMES_NOTE))).toBe(false);
    await new Promise((r) => setTimeout(r, 30));
    expect(fs.readFileSync(logFilePath(), 'utf8')).toMatch(/問い合わせ中（画面 3 枚・指示 2 字・記録 \d+ 字）/);
  });

  it('画面がまだない: 画像を入れず、画面が届いていないことを書き添える', async () => {
    const ai = fakeAi(async () => ({ text: 'スルー' }));
    await new Responder(cfg, ai).ask({ instruction: '指示', transcript: '配信者: オルダ', frames: [] });
    const parts = ai.models.generateContent.mock.calls[0][0].contents[0].parts;
    expect(parts.some((p) => p.inlineData)).toBe(false);
    expect(parts.some((p) => p.text?.includes(NO_FRAMES_NOTE))).toBe(true);
  });

  it('返事の文章がない: 空文字を返す', async () => {
    expect(await new Responder(cfg, fakeAi(async () => ({}))).ask({ instruction: '', transcript: '', frames: [] })).toBe('');
  });

  it('時間内に返事が届かない: 時間切れのエラーにする', async () => {
    vi.useFakeTimers();
    const r = new Responder({ ...cfg, timeoutMs: 1000 }, fakeAi(() => new Promise(() => {})));
    const p = r.ask({ instruction: '', transcript: '', frames: [] });
    const done = expect(p).rejects.toThrow('タイムアウト');
    await vi.advanceTimersByTimeAsync(1000);
    await done;
  });

  describe('返事を促さない・召喚のきっかけを伝える', () => {
    it('問い合わせの締めの文: 返事をするか黙るかを決めさせ、返事を促す言葉を含まない', async () => {
      const ai = fakeAi(async () => ({ text: 'スルー' }));
      await new Responder(cfg, ai).ask({ instruction: '', transcript: '配信者: よし。', frames: [] });
      const parts = ai.models.generateContent.mock.calls[0][0].contents[0].parts;
      expect(parts.at(-1).text).toBe(CLOSING);
      expect(CLOSING).toMatch(/返事をするか.*スルー/);
      expect(CLOSING).not.toMatch(/返事をしてください/);
    });

    it('召喚のきっかけがある: 締めの文の前に書き添える。なければ書き添えない', async () => {
      const ai = fakeAi(async () => ({ text: 'スルー' }));
      const r = new Responder(cfg, ai);
      await r.ask({ instruction: '', transcript: '', frames: [], summonNote: '# 召喚のきっかけ\nヴァール' });
      await r.ask({ instruction: '', transcript: '', frames: [] });
      const first = ai.models.generateContent.mock.calls[0][0].contents[0].parts.map((p) => p.text);
      const second = ai.models.generateContent.mock.calls[1][0].contents[0].parts.map((p) => p.text);
      expect(first.at(-2)).toBe('# 召喚のきっかけ\nヴァール');
      expect(second.some((x) => x?.includes('召喚のきっかけ'))).toBe(false);
    });

    it('締めの文を指定する（評価で以前の文と比べるとき）', async () => {
      const ai = fakeAi(async () => ({ text: 'スルー' }));
      await new Responder(cfg, ai).ask({ instruction: '', transcript: '', frames: [], closing: '以前の文' });
      expect(ai.models.generateContent.mock.calls[0][0].contents[0].parts.at(-1).text).toBe('以前の文');
    });
  });

  describe('答える役が検索を使える', () => {
    it('検索が有効: Google 検索の道具を付ける。無効なら付けない', async () => {
      const ai = fakeAi(async () => ({ text: 'はい' }));
      await new Responder({ ...cfg, search: true }, ai).ask({ instruction: '', transcript: '', frames: [] });
      await new Responder({ ...cfg, search: false }, ai).ask({ instruction: '', transcript: '', frames: [] });
      expect(ai.models.generateContent.mock.calls[0][0].config.tools).toEqual([{ googleSearch: {} }]);
      expect(ai.models.generateContent.mock.calls[1][0].config.tools).toBeUndefined();
    });

    it('検索した: 検索した言葉をログに記録する', async () => {
      const ai = fakeAi(async () => ({ text: 'はい', candidates: [{ groundingMetadata: { webSearchQueries: ['ラグナロクオンライン イベント'] } }] }));
      await new Responder({ ...cfg, search: true }, ai).ask({ instruction: '', transcript: '', frames: [] });
      await new Promise((r) => setTimeout(r, 30));
      expect(fs.readFileSync(logFilePath(), 'utf8')).toMatch(/🔎 検索: ラグナロクオンライン イベント/);
    });
  });
});