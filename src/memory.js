// 会話の記憶: 書き起こしを溜め、Live セッションを張り直すたびに「要約 + 直近の数往復」へ圧縮する。
//
//   [persona.md] + [これまでの要約 (≦ SUMMARY_MAX_CHARS)] + [直近 RECENT_ENTRIES 件の発言そのまま]
//
// を新しいセッションの systemInstruction にすることで、コンテキストの大きさを一定に保つ。
// 要約は別のテキストモデル（既定 gemini-3.5-flash-lite）で作る。中身は logs/summary.txt で確認できる。
import fs from 'node:fs';
import path from 'node:path';
import { logger } from './log.js';

const log = logger('memory');
const SUMMARY_FILE = path.resolve('logs', 'summary.txt');

export class Memory {
  constructor({ ai, model, maxChars, recentEntries, persona }) {
    this.ai = ai;
    this.model = model;
    this.maxChars = maxChars;
    this.recentEntries = recentEntries;
    this.persona = persona;
    this.summary = '';
    this.entries = []; // { role: '配信者' | '相方' | 'チャット', text }
    this.summarizing = null;
  }

  // 文字起こしは細切れで届くので、同じ話者が続く間は 1 件にまとめる
  add(role, text) {
    if (!text) return;
    const last = this.entries.at(-1);
    if (last && last.role === role && role !== 'チャット') last.text += text;
    else this.entries.push({ role, text });
  }

  format(entries) {
    return entries.map((e) => `${e.role}: ${e.text.trim()}`).join('\n');
  }

  // 直近ぶんを残して、それより前を要約に畳み込む
  async summarize() {
    if (this.summarizing) return this.summarizing;
    const old = this.entries.slice(0, Math.max(0, this.entries.length - this.recentEntries));
    if (!old.length) return;
    this.summarizing = (async () => {
      const t0 = Date.now();
      const prompt = `あなたはライブ配信の記録係です。「これまでの要約」と「新しい書き起こし」をもとに、要約を更新してください。

# ルール
- 日本語で ${this.maxChars} 文字以内。箇条書きでよい
- 残すもの: 配信で今やっていること、話題の流れ、配信者が話した事実・好み・予定、相方との約束や持ちネタ、何度も来ているチャット参加者の名前と特徴
- 捨てるもの: 相づち、挨拶の繰り返し、細かい言い回し
- 書き起こしは自動音声認識なので誤字がある。文脈から補ってよいが、推測で事実を作らない
- 要約本文だけを出力する

# これまでの要約
${this.summary || '（なし。配信開始直後）'}

# 新しい書き起こし
${this.format(old)}`;
      const res = await this.ai.models.generateContent({ model: this.model, contents: prompt });
      const text = res.text?.trim();
      if (!text) throw new Error('要約が空でした');
      this.summary = text;
      this.entries.splice(0, old.length);
      fs.writeFileSync(SUMMARY_FILE, `# ${new Date().toLocaleString('ja-JP')}\n\n${text}\n`);
      log.info(`要約を更新 (${old.length} 件 → ${text.length} 文字, ${Date.now() - t0}ms)\n${text}`);
    })().finally(() => (this.summarizing = null));
    return this.summarizing;
  }

  // 新しいセッションに渡すシステムプロンプト
  instruction() {
    if (!this.summary && !this.entries.length) return this.persona;
    return `${this.persona}

# これまでの配信の流れ（要約）
${this.summary || '（まだなし）'}

# 直前のやり取り
${this.format(this.entries) || '（なし）'}

上の続きから自然に会話を続けてください。接続が切り替わったことや、この要約の存在には触れないでください。`;
  }
}
