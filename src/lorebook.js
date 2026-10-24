// ロアブック（控え）: 言葉（人物・視聴者・場所・アイテム・用語など）ごとの詳しい情報を、キーワードつきで持っておく。
// 要約は流れと出来事だけを持ち、言葉の詳細はここが持つ。問い合わせのたびに直近の記録からキーワードを探し、
// 当たった項目だけを答える役への指示に入れる（AI は使わず、文字列の照合だけ）。
//
// 項目の作り方: 返事の合図【記憶: キーワード=A、B ／ 内容=…】、要約のついで（memory.js）、コンソールの k
// 保存先: logs/lorebook.json（{ entries: [{ id, keys, content, createdAt, updatedAt }] }。手で直してもよい）
import fs from 'node:fs';
import path from 'node:path';
import { logger } from './log.js';

const log = logger('lorebook');
const REMEMBER = /【記憶[:：]\s*([^】]*)】/g;
const FORGET = /【忘却[:：]\s*([^】]*)】/g;
const REMEMBER_BODY = /^キーワード\s*[=＝]\s*(.+?)\s*[／/]\s*内容\s*[=＝]\s*([\s\S]+)$/;

// 照合用に表記をそろえる: 全角英数→半角（NFKC）、ひらがな→カタカナ、英字→小文字
export function normalize(s) {
  return s
    .normalize('NFKC')
    .replace(/[ぁ-ゖ]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 0x60))
    .toLowerCase();
}

const splitKeys = (s) => s.split(/[、,，]/).map((k) => k.trim()).filter(Boolean);
const label = (e) => `[${e.keys.join(', ')}]`;

export class Lorebook {
  constructor({ file = path.resolve('logs', 'lorebook.json'), scanEntries = 6, stickyAsks = 3, maxChars = 3000 } = {}) {
    this.file = file;
    this.scanEntries = scanEntries;
    this.stickyAsks = stickyAsks;
    this.maxChars = maxChars;
    this.entries = [];
    this.active = new Map(); // id → あと何回入れたままにするか
    this.lastHit = new Map(); // id → 最後に当たった順番（大きいほど最近）
    this.seq = 0;
  }

  load() {
    if (!fs.existsSync(this.file)) return;
    try {
      this.entries = JSON.parse(fs.readFileSync(this.file, 'utf8')).entries ?? [];
      log.info(`控えを ${this.entries.length} 件読み込みました`);
    } catch (e) {
      log.warn(`控えを読み込めません。空で始めます: ${e.message}`);
      this.entries = [];
    }
  }

  save() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify({ entries: this.entries }, null, 2));
    } catch (e) {
      log.warn('控えを保存できません', e.message);
    }
  }

  // キーワードが既存の項目と重なれば、内容を置き換えて（append なら書き足して）キーワードを足す。なければ新しく作る
  add({ keys, content }, { append = false } = {}) {
    keys = keys.map((k) => k.trim()).filter(Boolean);
    content = content?.trim();
    if (!keys.length || !content) return null;
    const now = new Date().toISOString();
    const norm = new Set(keys.map(normalize));
    const hit = this.entries.find((e) => e.keys.some((k) => norm.has(normalize(k))));
    if (hit) {
      const have = new Set(hit.keys.map(normalize));
      hit.keys.push(...keys.filter((k) => !have.has(normalize(k))));
      hit.content = append ? `${hit.content}\n${content}` : content;
      hit.updatedAt = now;
      log.info(`控えを更新しました ${label(hit)} ${content}`);
    } else {
      const id = this.entries.reduce((m, e) => Math.max(m, e.id), 0) + 1;
      this.entries.push({ id, keys, content, createdAt: now, updatedAt: now });
      log.info(`控えを作りました ${label(this.entries.at(-1))} ${content}`);
    }
    this.save();
    return hit ?? this.entries.at(-1);
  }

  // そのキーワードを持つ項目をすべて消す
  removeByKey(key) {
    const k = normalize(key.trim());
    const gone = this.entries.filter((e) => e.keys.some((x) => normalize(x) === k));
    if (!gone.length) return 0;
    this.entries = this.entries.filter((e) => !gone.includes(e));
    for (const e of gone) log.info(`控えを消しました ${label(e)}`);
    this.save();
    return gone.length;
  }

  // 一覧の番号（1 から）で消す
  removeAt(n) {
    const e = this.entries[n - 1];
    if (!e) return false;
    this.entries.splice(n - 1, 1);
    log.info(`控えを消しました ${label(e)}`);
    this.save();
    return true;
  }

  list() {
    return this.entries.map((e, i) => `${i + 1}. ${label(e)} ${e.content}`).join('\n');
  }

  // 返事の中の合図（記憶・忘却）を実行し、合図を取り除いた文を返す
  apply(reply) {
    let text = reply.replace(REMEMBER, (_, body) => {
      const m = body.trim().match(REMEMBER_BODY);
      // 出来事の記憶なので、その日の日付を付け、既にある言葉には書き足す
      if (m) this.add({ keys: splitKeys(m[1]), content: `（${new Date().toLocaleDateString('ja-JP')}）${m[2].trim()}` }, { append: true });
      else log.warn(`控えの合図を読めません: 【記憶: ${body}】`);
      return '';
    });
    text = text.replace(FORGET, (_, key) => {
      if (key.trim()) this.removeByKey(key);
      return '';
    });
    return text.trim();
  }

  // キーワードが含まれる項目
  matches(text) {
    const t = normalize(text);
    return this.entries.filter((e) => e.keys.some((k) => t.includes(normalize(k))));
  }

  // 今回の問い合わせに入れる控え（指示の末尾に足す文）。当たった項目は stickyAsks 回のあいだ入れたままにする
  select(recentText) {
    const hits = this.matches(recentText);
    for (const e of hits) {
      this.active.set(e.id, this.stickyAsks);
      this.lastHit.set(e.id, ++this.seq);
    }
    const hitIds = new Set(hits.map((e) => e.id));
    const chosen = this.entries.filter((e) => {
      if (hitIds.has(e.id)) return true;
      const left = this.active.get(e.id) ?? 0;
      if (left <= 0) return false;
      this.active.set(e.id, left - 1);
      return true;
    });
    chosen.sort((a, b) => (this.lastHit.get(b.id) ?? 0) - (this.lastHit.get(a.id) ?? 0));
    const fit = [];
    const dropped = [];
    let used = 0;
    for (const e of chosen) {
      if (used + e.content.length <= this.maxChars) {
        fit.push(e);
        used += e.content.length;
      } else dropped.push(e);
    }
    if (dropped.length) log.warn(`上限 ${this.maxChars} 字を超えるので入れなかった控え: ${dropped.map(label).join(', ')}`);
    if (!fit.length) return '';
    log.info(`控えを入れます ${fit.map(label).join(', ')}`);
    return `# 控え（話題に出た言葉についての、確かな情報）\n${fit.map((e) => `- ${label(e)} ${e.content}`).join('\n')}`;
  }

  // 退去したら、入れたままの項目を外す
  reset() {
    this.active.clear();
  }
}
