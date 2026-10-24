// 会話の記憶: 発話・返事・チャットを記録し、たまったら古い部分を要約に畳み込む。配信をまたいで要約を積み上げる。
//
//   指示 = [persona.md] + [今日の配信] + [これまでの配信の要約（累積）] + [ここまでの要約 (≦ SUMMARY_MAX_CHARS)]
//   記録 = 要約以降の発言すべて（「話者: 発言」）
//
// を答える役への問い合わせに使う。要約していない記録が SUMMARIZE_AT_CHARS を超えたら、
// 直近 RECENT_ENTRIES 件を残して要約する。要約は別のモデル（既定 gemini-3.8-flash）で作り、logs/summary.txt で確認できる。
//
// 配信をまたぐ記憶（logs/carryover.json）:
//   { savedAt, longSummary: 累積の要約, pending: [{ at, summary }] まだまとめ直していない回, recent: 最後に中身があった回の直近の発言 }
// 終了時に、累積の要約・pending・今回の要約を 1 つにまとめ直す（≦ LONG_SUMMARY_MAX_CHARS）。各回の要約は logs/sessions/ に残す。
// 動作確認だけの回は要約が「（なし）」になり、引き継ぎを何も変えない。
import fs from 'node:fs';
import path from 'node:path';
import { logger } from './log.js';

const log = logger('memory');
const FINALIZE_TIMEOUT_MS = 8000;
const MERGE_TIMEOUT_MS = 60000;
const STREAM_DESCRIPTION_MAX = 1000;
// 残すものがないときに要約のモデルが返す言葉
export const NOTHING = '（なし）';
const isNothing = (s) => !s || s.replace(/[\s（）()。]/g, '') === 'なし';

const withTimeout = (p, ms) => {
  let t;
  return Promise.race([p, new Promise((_, rej) => (t = setTimeout(() => rej(new Error('タイムアウト')), ms)))]).finally(() =>
    clearTimeout(t),
  );
};

export class Memory {
  constructor({
    ai, model, maxChars, recentEntries, persona, summarizeAtChars = 12000, longMaxChars = 20000,
    summaryFile = path.resolve('logs', 'summary.txt'),
    stateFile = path.resolve('logs', 'carryover.json'), // 配信をまたいで引き継ぐ記憶
    sessionsDir = path.join(path.dirname(stateFile), 'sessions'), // 各回の要約の履歴
  }) {
    this.ai = ai;
    this.model = model;
    this.maxChars = maxChars;
    this.longMaxChars = longMaxChars;
    this.recentEntries = recentEntries;
    this.summarizeAtChars = summarizeAtChars;
    this.persona = persona;
    this.summaryFile = summaryFile;
    this.stateFile = stateFile;
    this.sessionsDir = sessionsDir;
    this.startedAt = new Date();
    // 前回までに引き継いだ記憶
    this.longSummary = '';
    this.pending = [];
    this.prevRecent = [];
    this.streamInfo = ''; // 今日の配信のタイトルと概要欄
    this.summary = '';
    this.entries = []; // { role: '配信者' | '相方' | 'チャット', text, sealed? }
    this.lastRecent = null; // 終了時に全部を要約する前に取っておいた直近の発言
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

  // 要約のモデルに渡す「すでに与えている情報」（ここにあることは要約に繰り返させない）
  givenInfo() {
    return this.persona + (this.streamInfo ? `\n\n## 今日の配信\n${this.streamInfo}` : '');
  }

  buildPrompt(old) {
    return `あなたはライブ配信の記録係です。「これまでの要約」と「新しい書き起こし」をもとに、今回の配信の要約を更新してください。

# ルール
- 日本語で ${this.maxChars} 文字以内。見出しと箇条書きで整理する。字数に余裕があれば、細部を省かずに残す
- 残すもの:
  - 配信で今やっていることと、ここまでの流れ（どこで何をして、何が起きたか）
  - 配信者が読み上げた物語やセリフの要点（登場人物、出来事、固有名詞）
  - 配信者が話した事実・好み・予定・感想
  - 配信者や視聴者が教えてくれたこと、訂正されたこと（相方の誤りが訂正された場合は、正しい内容を残す）
  - 相方が聞かれて答えた内容
  - 常連の視聴者の名前と特徴
- 捨てるもの:
  - 相づち、挨拶の繰り返し、言い淀み、同じ内容の繰り返し
  - 相方（AI）の仕組みの動作確認・設定・不具合のやり取り（「聞こえる？」「テスト」、プロンプトや設定、AI の調子の話など）
  - 「すでに与えている情報」に書いてあること（配信者や相方の名前・設定、配信のタイトルなど）。繰り返さない
- 書き起こしは自動音声認識なので誤字がある。文脈から補ってよいが、推測で事実を作らない
- 残すものが何もなければ「${NOTHING}」とだけ出力する
- 要約本文だけを出力する

# すでに与えている情報（相方への指示として別に渡している）
${this.givenInfo()}

# これまでの要約
${this.summary || '（なし。配信開始直後）'}

# 新しい書き起こし
${this.format(old)}`;
  }

  buildMergePrompt(current) {
    const unmerged = [...this.pending, { at: this.startedAt.toISOString(), summary: current }]
      .map((p) => `## ${new Date(p.at).toLocaleString('ja-JP')} の配信\n${p.summary}`)
      .join('\n\n');
    return `あなたはライブ配信の記録係です。配信をまたいで覚えておくための「これまでの配信の要約」を更新してください。

# ルール
- 日本語で ${this.longMaxChars} 文字以内。見出しと箇条書きで整理する
- 配信ごと（日付）に見出しを立てる。新しい配信ほど詳しく、古い配信ほど要点に縮める
- 複数の配信にまたがって分かったこと（配信者の好みや予定、進行中の目標、常連の視聴者とその特徴など）は、別の見出しにまとめる
- 捨てるもの:
  - 相方（AI）の仕組みの動作確認・設定・不具合のやり取り
  - 「すでに与えている情報」に書いてあること（配信者や相方の名前・設定など）。繰り返さない
- 推測で事実を作らない
- 要約本文だけを出力する

# すでに与えている情報（相方への指示として別に渡している）
${this.persona}

# これまでの配信の要約
${this.longSummary || '（なし）'}

# まだまとめていない配信の要約（古い順）
${unmerged}`;
  }

  // 直近 keep 件を残して、それより前を要約に畳み込む。実行中に呼ばれたら同じ処理の完了を待つ
  summarize(keep = this.recentEntries) {
    if (this.summarizing) return this.summarizing;
    const old = this.entries.slice(0, Math.max(0, this.entries.length - keep));
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

  // 引き継ぎを保存する。累積の要約は変えない。今回の要約に中身がなければ、前回の内容をそのまま残す
  save() {
    const meaningful = !isNothing(this.summary);
    const recent = this.lastRecent ?? this.entries;
    this.writeState({
      longSummary: this.longSummary,
      pending: meaningful ? [...this.pending, { at: this.startedAt.toISOString(), summary: this.summary }] : this.pending,
      recent: meaningful ? recent.map(({ role, text }) => ({ role, text })) : this.prevRecent,
    });
  }

  writeState(state) {
    try {
      fs.mkdirSync(path.dirname(this.stateFile), { recursive: true });
      fs.writeFileSync(this.stateFile, JSON.stringify({ savedAt: new Date().toISOString(), ...state }, null, 2));
    } catch (e) {
      log.warn('記憶を保存できません', e.message);
    }
  }

  // 終了時: 今回分を最後まで要約し、累積の要約とまとめ直して保存する。
  // 要約に失敗しても時間切れでも、その時点の内容は保存する（まとめ直しは次回の終了時に持ち越す）
  async finalize() {
    if (!this.summary && !this.entries.length) return;
    this.lastRecent = this.entries.slice(-this.recentEntries);
    try {
      await withTimeout(this.summarize(0), FINALIZE_TIMEOUT_MS);
    } catch (e) {
      log.warn(`終了時の要約に失敗したので、その時点の内容を保存します: ${e.message}`);
    }
    if (isNothing(this.summary)) {
      this.save();
      log.info('今回は残すことがなかったので、引き継ぎの記憶は変えません');
      return;
    }
    this.writeHistory();
    try {
      const t0 = Date.now();
      const res = await withTimeout(
        this.ai.models.generateContent({ model: this.model, contents: this.buildMergePrompt(this.summary) }),
        MERGE_TIMEOUT_MS,
      );
      const merged = res.text?.trim();
      if (!merged) throw new Error('まとめ直した要約が空でした');
      this.writeState({ longSummary: merged, pending: [], recent: this.lastRecent.map(({ role, text }) => ({ role, text })) });
      log.info(`これまでの配信の要約をまとめ直しました (${merged.length} 文字, ${Date.now() - t0}ms): ${this.stateFile}`);
    } catch (e) {
      this.save();
      log.warn(`これまでの配信の要約をまとめ直せませんでした。次回の終了時にまとめ直します: ${e.message}`);
    }
  }

  // 今回の要約を日時つきで履歴に残す
  writeHistory() {
    try {
      fs.mkdirSync(this.sessionsDir, { recursive: true });
      const name = this.startedAt.toISOString().replace(/[:.]/g, '-').slice(0, 19);
      fs.writeFileSync(path.join(this.sessionsDir, `${name}.md`), `# ${this.startedAt.toLocaleString('ja-JP')} の配信\n\n${this.summary}\n`);
    } catch (e) {
      log.warn('要約の履歴を保存できません', e.message);
    }
  }

  // 起動時: 前回保存した記憶を読み込む。読めたら true
  loadPrevious() {
    if (!fs.existsSync(this.stateFile)) return false;
    try {
      const s = JSON.parse(fs.readFileSync(this.stateFile, 'utf8'));
      // 以前の形式（要約が 1 つだけ）は、その要約を累積の要約として読む
      this.longSummary = s.longSummary ?? s.summary ?? '';
      this.pending = s.pending ?? [];
      this.prevRecent = s.recent ?? [];
      log.info(`前回の記憶を引き継ぎます（${s.savedAt ? new Date(s.savedAt).toLocaleString('ja-JP') : '日時不明'} に保存）`);
      return !!this.previous;
    } catch (e) {
      log.warn(`前回の記憶を読み込めません。引き継がずに起動します: ${e.message}`);
      return false;
    }
  }

  // 指示に入れる、前回までの記憶
  get previous() {
    const pending = this.pending.map((p) => `## ${new Date(p.at).toLocaleString('ja-JP')} の配信\n${p.summary}`).join('\n\n');
    const recent = this.format(this.prevRecent);
    return [this.longSummary, pending, recent && `前回の配信の最後のやり取り:\n${recent}`].filter(Boolean).join('\n\n');
  }

  // 今日の配信のタイトルと概要欄を設定する。内容が変わったら true
  setStreamInfo({ title = '', description = '' }) {
    const text = `タイトル: ${title}\n概要欄:\n${description.slice(0, STREAM_DESCRIPTION_MAX)}`;
    if (text === this.streamInfo) return false;
    this.streamInfo = text;
    log.info(`今日の配信の情報を設定: ${title}`);
    return true;
  }

  // 答える役への指示: ペルソナ → 今日の配信 → これまでの配信 → 今回のここまでの要約
  instruction() {
    const previous = this.previous;
    return (
      this.persona +
      (this.streamInfo ? `\n\n# 今日の配信\n${this.streamInfo}` : '') +
      (previous ? `\n\n# これまでの配信の要約\n${previous}` : '') +
      (this.summary && !isNothing(this.summary) ? `\n\n# 今回のここまでの要約\n${this.summary}` : '')
    );
  }

  // 要約以降の記録
  transcript() {
    return this.format(this.entries);
  }
}
