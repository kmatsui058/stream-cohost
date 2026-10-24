// 答える役: 召喚中の発話に、通常の生成 API のモデル（既定 gemini-4-argon）で返事を作る。
// 1 回の問い合わせに、指示（ペルソナ・配信の情報・要約）、要約以降の記録すべて、直近の配信画面の静止画を入れる。
import { GoogleGenAI } from '@google/genai';
import { logger } from './log.js';

const log = logger('responder');
export const NO_FRAMES_NOTE = '（配信画面はまだ届いていません。画面について聞かれたら、見えていないと答えてください）';
const CLOSING = '上の記録の最後までを踏まえて、相方として返事をしてください。';

export class Responder {
  constructor(cfg, ai = new GoogleGenAI({ apiKey: cfg.apiKey })) {
    this.cfg = cfg;
    this.ai = ai;
  }

  // 返事の文章を返す。エラーや時間切れは例外になる
  async ask({ instruction, transcript, frames }) {
    const parts = [{ text: `# 要約以降の記録\n${transcript}` }];
    if (frames.length) {
      parts.push({ text: '# 直近の配信画面（古い順）' });
      for (const data of frames) parts.push({ inlineData: { mimeType: 'image/jpeg', data } });
    } else {
      parts.push({ text: NO_FRAMES_NOTE });
    }
    parts.push({ text: CLOSING });
    const t0 = Date.now();
    let timer;
    try {
      const res = await Promise.race([
        this.ai.models.generateContent({
          model: this.cfg.model,
          contents: [{ role: 'user', parts }],
          config: { systemInstruction: instruction, ...(this.cfg.search && { tools: [{ googleSearch: {} }] }) },
        }),
        new Promise((_, reject) => (timer = setTimeout(() => reject(new Error('タイムアウト')), this.cfg.timeoutMs))),
      ]);
      log.info(`返事を受け取りました (${Date.now() - t0}ms)`);
      const queries = res.candidates?.[0]?.groundingMetadata?.webSearchQueries;
      if (queries?.length) log.info(`🔎 検索: ${queries.join(' / ')}`);
      return (res.text ?? '').trim();
    } finally {
      clearTimeout(timer);
    }
  }
}
