// 評価用: Live ではなく通常の生成 API（generateContent）で、1 回の入力に対する返事を受け取る。
// Live のモデル（その場で即答する）と、考えてから答えるテキストのモデルを、同じ指示・入力で比べるために使う。
export async function askText(ai, v, systemInstruction, text) {
  const config = { systemInstruction };
  if (v.thinkingLevel) config.thinkingConfig = { thinkingLevel: v.thinkingLevel };
  if (v.tools?.length) config.tools = v.tools.map((name) => ({ [name]: {} }));
  const t0 = Date.now();
  const res = await ai.models.generateContent({ model: v.model, contents: text, config });
  const ms = Date.now() - t0;
  const signals = res.candidates?.[0]?.groundingMetadata ? ['groundingMetadata'] : [];
  // 文字が届き始める時間は測れないので、終わるまでの時間と同じにする
  return { text: (res.text ?? '').trim(), ms, firstMs: ms, signals };
}
