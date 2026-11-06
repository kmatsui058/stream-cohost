// 方針: 配信者が相方の振る舞いについて伝えたこと（いつも守ること）。キーワードに関係なく、毎回の指示に入れる。
// 記憶の役割分担: 要約＝流れ、控え（lorebook）＝言葉ごとの出来事、方針＝いつも守ること。
//
// 足し方: 返事の合図【方針: …】、コンソールの pl
// 保存先: logs/policies.json（{ policies: [{ text, createdAt }] }。手で直してもよい）
import fs from 'node:fs';
import path from 'node:path';
import { logger } from './log.js';

const log = logger('policies');
const MARKER = /【方針[:：]\s*([^】]*)】/g;

export class Policies {
  constructor({ file = path.resolve('logs', 'policies.json'), maxChars = 1000 } = {}) {
    this.file = file;
    this.maxChars = maxChars;
    this.policies = [];
  }

  load() {
    if (!fs.existsSync(this.file)) return;
    try {
      this.policies = JSON.parse(fs.readFileSync(this.file, 'utf8')).policies ?? [];
      log.info(`方針を ${this.policies.length} 件読み込みました`);
    } catch (e) {
      log.warn(`方針を読み込めません。空で始めます: ${e.message}`);
      this.policies = [];
    }
  }

  save() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify({ policies: this.policies }, null, 2));
    } catch (e) {
      log.warn('方針を保存できません', e.message);
    }
  }

  // 同じ内容がすでにあれば足さない
  add(text) {
    text = text?.trim();
    if (!text || this.policies.some((p) => p.text === text)) return false;
    this.policies.push({ text, createdAt: new Date().toISOString() });
    log.info(`方針を足しました: ${text}`);
    this.save();
    return true;
  }

  removeAt(n) {
    const p = this.policies[n - 1];
    if (!p) return false;
    this.policies.splice(n - 1, 1);
    log.info(`方針を消しました: ${p.text}`);
    this.save();
    return true;
  }

  list() {
    return this.policies.map((p, i) => `${i + 1}. ${p.text}`).join('\n');
  }

  // 返事の中の合図【方針: …】を保存し、合図を取り除いた文を返す
  apply(reply) {
    return reply
      .replace(MARKER, (_, text) => {
        this.add(text);
        return '';
      })
      .trim();
  }

  // 毎回の指示に入れる欄。上限を超えたら新しいものを優先する
  section() {
    const fit = [];
    const dropped = [];
    let used = 0;
    for (const p of [...this.policies].reverse()) {
      if (used + p.text.length <= this.maxChars) {
        fit.unshift(p);
        used += p.text.length;
      } else dropped.push(p);
    }
    if (dropped.length) log.warn(`上限 ${this.maxChars} 字を超えるので入れなかった方針: ${dropped.map((p) => p.text).join(' / ')}`);
    if (!fit.length) return '';
    return `# マスターの方針（いつも守ること）\n${fit.map((p) => `- ${p.text}`).join('\n')}`;
  }
}
