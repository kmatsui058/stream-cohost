import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'node:fs';
import { Responder, NO_FRAMES_NOTE } from '../src/responder.js';
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