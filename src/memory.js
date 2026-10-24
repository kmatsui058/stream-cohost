// 会話の記憶: 発話・返事・チャットを記録し、たまったら古い部分を要約に畳み込む。
//
//   指示 = [persona.md] + [今日の配信] + [前回の配信] + [ここまでの要約 (≦ SUMMARY_MAX_CHARS)]
//   記録 = 要約以降の発言すべて（「話者: 発言」）
//
// を答える役への問い合わせに使う。要約していない記録が SUMMARIZE_AT_CHARS を超えたら、
// 直近 RECENT_ENTRIES 件を残して要約する。要約は別のモデル（既定 gemini-3.8-flash）で作り、logs/summary.txt で確認できる。
import fs from 'node:fs';
import path from 'node:path';
import { logger } from './log.js';

const log = logger('memory');
const FINALIZE_TIMEOUT_MS = 8000;
const STREAM_DESCRIPTION_MAX = 1000;

export class Memory {
  constructor({
    ai, model, maxChars, recentEntries, persona, summarizeAtChars = 12000,
    summaryFile = path.resolve('logs', 'summary.txt'),
    stateFile = path.resolve('logs', 'carryover.json'), // 配信をまたいで引き継ぐ記憶
  }) {
    this.ai = ai;
    this.model = model;
    this.maxChars = maxChars;
    this.recentEntries = recentEntries;
    this.summarizeAtChars = summarizeAtChars;
    this.persona = persona;
    this.summaryFile = summaryFile;
    this.stateFile = stateFile;
    this.previous = ''; // 前回の配信から引き継いだ記憶（指示に入れるだけで、今回の要約には混ぜない）
    this.streamInfo = ''; // 今日の配信のタイトルと概要欄
    this.summary = '';
    this.entries = []; // { role: '配信者' | '相方' | 'チャット', text, sealed? }
    this.summarizing = null;
  }

  // 発話・返事・チャットを 1 件ずつ記録する
  add(role, text) {
    if (!text) return;
    this.entries.push({ role, text });
  }

  // 要約していない記録の文字数
  get pendingChars() {
    return this.entries.reduce((n, e) => n + (e.sealed ? 0 : e.text.length), 0);
  }

  // 記録がたまっていたら要約する（結果は待たない。失敗は警告に残す）
  maybeSummarize() {
    if (this.summarizing || this.pendingChars <= this.summarizeAtChars) return;
    this.summarize().catch((e) => log.warn(`要約に失敗しました。次の機会に再試行します: ${e.message}`));
  }

  format(entries) {
    return entries.map((e) => `${e.role}: ${e.text.trim()}`).join('\n');
  }

  buildPrompt(old) {
    return `あなたはライブ配信の記録係です。「これまでの要約」と「新しい書き起こし」をもとに、要約を更新してください。

# ルール
- 日本語で ${this.maxChars} 文字以内。見出しと箇条書きで整理する。字数に余裕があれば、細部を省かずに残す
- 残すもの:
  - 配信で今やっていることと、ここまでの流れ（どこで何をして、何が起きたか）
  - 配信者が読み上げた物語やセリフの要点（登場人物、出来事、固有名詞）
  - 配信者が話した事実・好み・予定・感想
  - 配信者や視聴者が教えてくれたこと、訂正されたこと（相方の誤りが訂正された場合は、正しい内容を残す）
  - 相方が聞かれて答えた内容
  - 常連の視聴者の名前と特徴
- 捨てるもの: 相づち、挨拶の繰り返し、言い淀み、同じ内容の繰り返し
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

  // 今日の配信のタイトルと概要欄を設定する。内容が変わったら true
  setStreamInfo({ title = '', description = '' }) {
    const text = `タイトル: ${title}\n概要欄:\n${description.slice(0, STREAM_DESCRIPTION_MAX)}`;
    if (text === this.streamInfo) return false;
    this.streamInfo = text;
    log.info(`今日の配信の情報を設定: ${title}`);
    return true;
  }

  // 答える役への指示: ペルソナ → 今日の配信 → 前回の配信 → ここまでの要約
  instruction() {
    return (
      this.persona +
      (this.streamInfo ? `\n\n# 今日の配信\n${this.streamInfo}` : '') +
      (this.previous ? `\n\n# 前回の配信の要約\n${this.previous}` : '') +
      (this.summary ? `\n\n# ここまでの配信の要約\n${this.summary}` : '')
    );
  }

  // 要約以降の記録
  transcript() {
    return this.format(this.entries);
  }
}
