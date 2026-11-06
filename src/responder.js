// 答える役: 召喚中の発話に、通常の生成 API のモデル（既定 gemini-4-argon）で返事を作る。
// 1 回の問い合わせに、指示（ペルソナ・配信の情報・要約）、要約以降の記録すべて、直近の配信画面の静止画を入れる。
import { GoogleGenAI } from '@google/genai';
import { logger } from './log.js';

const log = logger('responder');
export const NO_FRAMES_NOTE = '（配信画面はまだ届いていません。画面について聞かれたら、見えていないと答えてください）';
// 返事を促さない（促すと、独り言や「よし」にも何か言おうとする）。返事をするか黙るかを決めさせるだけ
export const CLOSING = '記録の最後の発言に対して、返事をするか、黙る（スルー）かを決めてください。';

export class Responder {
  constructor(cfg, ai = new GoogleGenAI({ apiKey: cfg.apiKey })) {
    this.cfg = cfg;
    this.ai = ai;
  }

  // 返事の文章を返す。エラーや時間切れは例外になる
  // closing は評価で以前の締めの文と比べるときだけ指定する
  async ask({ instruction, transcript, frames, summonNote, closing = CLOSING }) {
    const parts = [{ text: `# 要約以降の記録\n${transcript}` }];
    if (frames.length) {
      parts.push({ text: '# 直近の配信画面（古い順）' });
      for (const data of frames) parts.push({ inlineData: { mimeType: 'image/jpeg', data } });
    } else {
      parts.push({ text: NO_FRAMES_NOTE });
    }
    if (summonNote) parts.push({ text: summonNote }); // 召喚した直後だけ、召喚のきっかけを書き添える
    parts.push({ text: closing });
    log.info(`問い合わせ中（画面 ${frames.length} 枚・指示 ${instruction.length} 字・記録 ${transcript.length} 字）`);
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
