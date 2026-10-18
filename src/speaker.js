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
  constructor(overlay, vvCfg) {
    super();
    this.overlay = overlay;
    this.vvCfg = vvCfg;
    this.queue = [];
    this.current = null; // { id, resolve }
    this.seq = 0;
    this.running = false;
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
    const item = { id: ++this.seq, text, wav: synthesize(text, this.vvCfg) };
    item.wav.catch(() => {}); // 未処理 rejection 防止（エラーは再生時に拾う）
    this.queue.push(item);
    if (!this.running) this.run();
  }

  async run() {
    this.running = true;
    this.emit('start');
    while (this.queue.length) {
      const item = this.queue.shift();
      let wav;
      try {
        wav = await item.wav;
      } catch (e) {
        log.error(`合成失敗「${item.text}」`, e.message);
        continue;
      }
      if (!this.running) break; // stop() された
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
    this.running = false;
    this.emit('idle');
  }

  stop() {
    if (!this.running && !this.queue.length) return;
    log.info('発話を中断');
    this.queue = [];
    this.running = false;
    this.overlay.broadcast({ type: 'stop' });
    this.current?.resolve();
  }
}
