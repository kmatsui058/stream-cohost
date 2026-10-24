// 進行役: 相方の「召喚 → 会話 → 退去」を管理する。
//
// - 待機中: 発話とチャットを記録するだけ。召喚の言葉（「オルダ」など）が入っていたら召喚する
// - 召喚中: 発話・チャットが届くたびに、答える役（responder）に問い合わせ、返事を文に区切って読み上げる
//           問い合わせは同時に 1 つ。待っている間に届いた発話は、返事の後に 1 回だけまとめて問い合わせる
// - 退去: 返事に【退去】が付いていたら待機に戻る。立ち絵は読み上げが終わってから消す
import { EventEmitter } from 'node:events';
import { logger } from './log.js';

const log = logger('director');

const SENTENCE_END = /[^。！？!?♪\n]*[。！？!?♪\n]+/g;
// 黙ると判断したときに AI が返す合図の言葉。これだけの返事は読み上げない
export const SILENT_MARKER = 'スルー';
// 会話が終わったと判断したときに AI が返事に付ける合図。読み上げない
export const DISMISS_MARKER = '【退去】';
export const isSilentReply = (text) => text.replace(/[\s。、．.!！?？…]/g, '') === SILENT_MARKER;

// 返事を読み上げの単位（文）に区切る。区切り記号で終わらない残りも 1 文にする
export function splitSentences(text) {
  const out = [];
  let consumed = 0;
  for (const m of text.matchAll(SENTENCE_END)) {
    if (m[0].trim()) out.push(m[0]);
    consumed = m.index + m[0].length;
  }
  const rest = text.slice(consumed).trim();
  if (rest) out.push(rest);
  return out;
}

// ひらがなをカタカナにそろえる（文字起こしが「おるだ」になっても召喚できるように）
const toKatakana = (s) => s.replace(/[ぁ-ゖ]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 0x60));

export class Director extends EventEmitter {
  constructor({ responder, speaker, memory, cfg, summonWords, getFrames = () => [] }) {
    super();
    this.responder = responder;
    this.speaker = speaker;
    this.memory = memory;
    this.cfg = cfg;
    this.summonWords = summonWords.map(toKatakana);
    this.getFrames = getFrames;
    this.summoned = false;
    this.shown = false; // 画面に相方を出しているか（退去後も読み上げが終わるまで出しておく）
    this.busy = false; // 問い合わせ中
    this.pending = false; // 問い合わせ中に新しい発話が届いた
    this.paused = false;
    speaker.on('idle', () => this.hideIfDismissed());
  }

  callsName(text) {
    const t = toKatakana(text);
    return this.summonWords.some((w) => t.includes(w));
  }

  onUtterance(text) {
    log.debug(`🎤 ${text}`);
    this.memory.add('配信者', text);
    // 相方が喋っている最中に配信者が話し始めたら黙らせる
    if (this.cfg.bargeIn && this.speaker.speaking && text.trim().length >= 2) this.speaker.stop();
    this.consider(this.callsName(text));
  }

  addChat(msgs) {
    for (const m of msgs) this.memory.add('チャット', `${m.author}: ${m.text}`);
    this.consider(msgs.some((m) => this.callsName(m.text)));
  }

  // 名前が呼ばれていれば召喚し、召喚中なら問い合わせる
  consider(named) {
    if (this.paused) return;
    if (!this.summoned && named) this.summon();
    if (this.summoned) this.request();
  }

  summon() {
    this.summoned = true;
    log.info('召喚されました');
    if (!this.shown) {
      this.shown = true;
      this.emit('presence', true);
    }
  }

  dismiss() {
    this.summoned = false;
    this.pending = false;
    log.info('退去しました');
    this.hideIfDismissed();
  }

  // 退去していて、読み上げも終わっていたら画面から消す
  hideIfDismissed() {
    if (this.summoned || !this.shown || this.speaker.speaking) return;
    this.shown = false;
    this.emit('presence', false);
  }

  toggleSummon() {
    if (this.summoned) this.dismiss();
    else this.summon();
  }

  request() {
    if (this.busy) {
      this.pending = true;
      return;
    }
    this.busy = true;
    this.ask().finally(() => {
      this.busy = false;
      if (this.pending && this.summoned && !this.paused) {
        this.pending = false;
        this.request();
      }
    });
  }

  async ask() {
    let reply;
    try {
      reply = await this.responder.ask({
        instruction: this.memory.instruction(),
        transcript: this.memory.transcript(),
        frames: this.getFrames(),
      });
    } catch (e) {
      log.error(`問い合わせに失敗しました: ${e.message}`);
      return;
    }
    if (this.paused) return;
    const dismiss = reply.includes(DISMISS_MARKER);
    const body = reply.replaceAll(DISMISS_MARKER, '').trim();
    if (!body || isSilentReply(body)) {
      log.info('（黙ると判断）');
    } else {
      log.info(`💬 ${body}`);
      this.memory.add('相方', body);
      for (const s of splitSentences(body)) this.speaker.push(s);
    }
    if (dismiss) this.dismiss();
    this.memory.maybeSummarize();
  }

  setPaused(p) {
    this.paused = p;
    if (p) this.speaker.stop();
    log.info(p ? '⏸ 一時停止（問い合わせと発話を止めます）' : '▶ 再開');
  }
}
