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
const FINALIZE_TIMEOUT_MS = 8000;

export class Memory {
  constructor({
    ai, model, maxChars, recentEntries, persona,
    summaryFile = path.resolve('logs', 'summary.txt'),
    stateFile = path.resolve('logs', 'carryover.json'), // 配信をまたいで引き継ぐ記憶
  }) {
    this.ai = ai;
    this.model = model;
    this.maxChars = maxChars;
    this.recentEntries = recentEntries;
    this.persona = persona;
    this.summaryFile = summaryFile;
    this.stateFile = stateFile;
    this.previous = ''; // 前回の配信から引き継いだ記憶（指示に入れるだけで、今回の要約には混ぜない）
    this.summary = '';
    this.entries = []; // { role: '配信者' | '相方' | 'チャット', text, sealed? }
    this.summarizing = null;
  }

  // 文字起こしは細切れで届くので、同じ話者が続く間は 1 件にまとめる。
  // ただし要約の対象になった発言（sealed）には結合しない（要約後に一緒に消えてしまうため）
  add(role, text) {
    if (!text) return;
    const last = this.entries.at(-1);
    if (last && last.role === role && role !== 'チャット' && !last.sealed) last.text += text;
    else this.entries.push({ role, text });
  }

  format(entries) {
    return entries.map((e) => `${e.role}: ${e.text.trim()}`).join('\n');
  }

  buildPrompt(old) {
    return `あなたはライブ配信の記録係です。「これまでの要約」と「新しい書き起こし」をもとに、要約を更新してください。

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
  }

  // 直近ぶんを残して、それより前を要約に畳み込む。実行中に呼ばれたら同じ処理の完了を待つ
  summarize() {
    if (this.summarizing) return this.summarizing;
    const old = this.entries.slice(0, Math.max(0, this.entries.length - this.recentEntries));
    if (!old.length) return Promise.resolve();
    for (const e of old) e.sealed = true;
    this.summarizing = (async () => {
      const t0 = Date.now();
      try {
        const res = await this.ai.models.generateContent({ model: this.model, contents: this.buildPrompt(old) });
        const text = res.text?.trim();
        if (!text) throw new Error('要約が空でした');
        this.summary = text;
        const done = new Set(old);
        this.entries = this.entries.filter((e) => !done.has(e));
        fs.mkdirSync(path.dirname(this.summaryFile), { recursive: true });
        fs.writeFileSync(this.summaryFile, `# ${new Date().toLocaleString('ja-JP')}\n\n${text}\n`);
        log.info(`要約を更新 (${old.length} 件 → ${text.length} 文字, ${Date.now() - t0}ms)\n${text}`);
        this.save();
      } catch (e) {
        for (const o of old) delete o.sealed;
        throw e;
      }
    })().finally(() => (this.summarizing = null));
    return this.summarizing;
  }

  // 今の要約と直近の発言を、次の起動で引き継げるように保存する
  save() {
    const state = {
      savedAt: new Date().toISOString(),
      summary: this.summary,
      recent: this.entries.map(({ role, text }) => ({ role, text })),
    };
    try {
      fs.mkdirSync(path.dirname(this.stateFile), { recursive: true });
      fs.writeFileSync(this.stateFile, JSON.stringify(state, null, 2));
    } catch (e) {
      log.warn('記憶を保存できません', e.message);
    }
  }

  // 終了時: 要約の更新を試みてから保存する。失敗しても時間切れでも、その時点の内容は保存する
  async finalize() {
    if (!this.summary && !this.entries.length) return;
    let timer;
    try {
      await Promise.race([
        this.summarize(),
        new Promise((_, rej) => (timer = setTimeout(() => rej(new Error('タイムアウト')), FINALIZE_TIMEOUT_MS))),
      ]);
    } catch (e) {
      log.warn(`終了時の要約に失敗したので、その時点の内容を保存します: ${e.message}`);
    } finally {
      clearTimeout(timer);
    }
    this.save();
    log.info(`記憶を保存しました: ${this.stateFile}`);
  }

  // 起動時: 前回保存した記憶を読み込む。読めたら true
  loadPrevious() {
    if (!fs.existsSync(this.stateFile)) return false;
    try {
      const s = JSON.parse(fs.readFileSync(this.stateFile, 'utf8'));
      const recent = (s.recent ?? []).map((e) => `${e.role}: ${e.text}`).join('\n');
      this.previous = [s.summary, recent && `直前のやり取り:\n${recent}`].filter(Boolean).join('\n\n');
      log.info(`前回の記憶を引き継ぎます（${s.savedAt ? new Date(s.savedAt).toLocaleString('ja-JP') : '日時不明'} に保存）`);
      return !!this.previous;
    } catch (e) {
      log.warn(`前回の記憶を読み込めません。引き継がずに起動します: ${e.message}`);
      return false;
    }
  }

  // 新しいセッションに渡すシステムプロンプト
  instruction() {
    const prev = this.previous ? `\n\n# 前回の配信の要約\n${this.previous}` : '';
    if (!this.summary && !this.entries.length) return this.persona + prev;
    return `${this.persona}${prev}

# これまでの配信の流れ（要約）
${this.summary || '（まだなし）'}

# 直前のやり取り
${this.format(this.entries) || '（なし）'}

上の続きから自然に会話を続けてください。接続が切り替わったことや、この要約の存在には触れないでください。`;
  }
}
