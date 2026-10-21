import { describe, it, expect, vi } from 'vitest';
import { askText } from '../eval/ask-text.js';

const fakeAi = (res) => ({ models: { generateContent: vi.fn(async () => res) } });

describe('prompt-eval / テキストのモデルで評価する', () => {
  it('テキストのモデルで返事を受け取る: 指示と入力で生成を 1 回呼び、返事と時間を記録する', async () => {
    const ai = fakeAi({ text: ' スルー \n', candidates: [{}] });
    const r = await askText(ai, { model: 'gemini-3.8-flash' }, '指示', '入力');
    expect(ai.models.generateContent).toHaveBeenCalledTimes(1);
    expect(ai.models.generateContent).toHaveBeenCalledWith({
      model: 'gemini-3.8-flash',
      contents: '入力',
      config: { systemInstruction: '指示' },
    });
    expect(r.text).toBe('スルー');
    expect(r.ms).toBeGreaterThanOrEqual(0);
    expect(r.firstMs).toBe(r.ms);
    expect(r.signals).toEqual([]);
  });

  it('考える量と検索を指定する: 設定に含め、検索の根拠情報を痕跡として記録する', async () => {
    const ai = fakeAi({ text: '答え', candidates: [{ groundingMetadata: { webSearchQueries: ['q'] } }] });
    const r = await askText(ai, { model: 'm', thinkingLevel: 'HIGH', tools: ['googleSearch'] }, '指示', '入力');
    expect(ai.models.generateContent.mock.calls[0][0].config).toEqual({
      systemInstruction: '指示',
      thinkingConfig: { thinkingLevel: 'HIGH' },
      tools: [{ googleSearch: {} }],
    });
    expect(r.signals).toEqual(['groundingMetadata']);
  });

  it('返事の文章が無い: 空の返事として扱う', async () => {
    const r = await askText(fakeAi({}), { model: 'm' }, '指示', '入力');
    expect(r.text).toBe('');
  });
});
