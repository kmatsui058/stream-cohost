// 発話キュー: 文単位で VOICEVOX 合成 → オーバーレイへ送信 → 再生完了を待って次へ。
// 合成は push 時点で先行開始するので、1 文目を再生している間に 2 文目が用意される。
import { EventEmitter } from 'node:events';
import { synthesize } from './voicevox.js';
import { logger } from './log.js';

const log = logger('speaker');

function wavSeconds(buf) {
  const byteRate = buf.readUInt32LE(28);
  return byteRate ? (buf.length - 44) / byteRate : 0;
}

export class Speaker extends EventEmitter {
  constructor(overlay, vvCfg, { synthesize: synth = synthesize } = {}) {
    super();
    this.overlay = overlay;
    this.vvCfg = vvCfg;
    this.synthesize = synth;
    this.queue = [];
    this.current = null; // { id, resolve }
    this.seq = 0;
    this.running = false;
    this.gen = 0; // 再生ループの世代番号
    overlay.on('ended', (id) => {
      if (this.current?.id === id) this.current.resolve();
    });
  }

  get speaking() {
    return this.running;
  }

  push(text) {
    text = text.trim();
    if (!text) return;
    const item = { id: ++this.seq, text, wav: this.synthesize(text, this.vvCfg) };
    item.wav.catch(() => {}); // 未処理 rejection 防止（エラーは再生時に拾う）
    this.queue.push(item);
    if (!this.running) this.run(this.gen);
  }

  // 再生ループ。stop() で世代が進んだら、待ちから戻った時点で何もせずに抜ける
  // （そうしないと、中断前に回された文を新しいループと並行して再生してしまう）
  async run(gen) {
    this.running = true;
    this.emit('start');
    while (gen === this.gen && this.queue.length) {
      const item = this.queue.shift();
      let wav;
      try {
        wav = await item.wav;
      } catch (e) {
        log.error(`合成失敗「${item.text}」`, e.message);
        continue;
      }
      if (gen !== this.gen) return; // stop() された
      const sec = wavSeconds(wav);
      log.info(`🔊 ${item.text}`);
      if (!this.overlay.hasClient) log.warn('オーバーレイ未接続のため音が出ていません（OBS のブラウザソースを確認）');
      this.overlay.broadcast({ type: 'say', id: item.id, text: item.text, wav: wav.toString('base64') });
      // 再生完了通知を待つ。届かない場合も尺 + 3 秒で先に進む
      await new Promise((resolve) => {
        const t = setTimeout(resolve, (sec + 3) * 1000);
        this.current = { id: item.id, resolve: () => { clearTimeout(t); resolve(); } };
      });
      this.current = null;
    }
    if (gen !== this.gen) return;
    this.running = false;
    this.emit('idle');
  }

  stop() {
    if (!this.running && !this.queue.length) return;
    log.info('発話を中断');
    this.gen++;
    this.queue = [];
    this.running = false;
    this.overlay.broadcast({ type: 'stop' });
    const cur = this.current;
    this.current = null;
    cur?.resolve();
    this.emit('idle');
  }
}
