// マイク入力: ffmpeg (DirectShow) で 16kHz / mono / s16le の生 PCM を stdout に出させて読む。
// Gemini Live の音声入力仕様が「16bit PCM 16kHz little-endian」なのでそのまま送れる。
import { spawn as nodeSpawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { logger } from './log.js';

const log = logger('mic');
export const CHUNK_BYTES = 3200; // 100ms 分 (16000Hz * 2byte * 0.1s)
const RESTART_MS = 3000;

export class Mic extends EventEmitter {
  constructor({ device, ffmpeg }, { spawn = nodeSpawn } = {}) {
    super();
    this.device = device;
    this.ffmpeg = ffmpeg;
    this.spawn = spawn;
    this.proc = null;
    this.stopped = false;
  }

  static args(device) {
    return ['-hide_banner', '-loglevel', 'error', '-f', 'dshow', '-audio_buffer_size', '50',
      '-i', `audio=${device}`, '-ac', '1', '-ar', '16000', '-f', 's16le', '-'];
  }

  start() {
    if (!this.device) throw new Error('MIC_DEVICE が未設定です（npm run mics で確認）');
    this.stopped = false;
    log.info(`ffmpeg 起動: ${this.device}`);
    const proc = this.spawn(this.ffmpeg, Mic.args(this.device), { stdio: ['ignore', 'pipe', 'pipe'] });
    this.proc = proc;

    let buf = Buffer.alloc(0);
    proc.stdout.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      while (buf.length >= CHUNK_BYTES) {
        this.emit('chunk', buf.subarray(0, CHUNK_BYTES));
        buf = buf.subarray(CHUNK_BYTES);
      }
    });
    proc.stderr.on('data', (d) => log.warn(d.toString().trim()));
    proc.on('error', (e) => log.error('ffmpeg を起動できません', e));
    proc.on('exit', (code) => {
      log.warn(`ffmpeg 終了 code=${code}`);
      if (this.proc === proc) this.proc = null;
      // デバイス抜けなどで落ちたら少し待って再起動
      if (!this.stopped) setTimeout(() => !this.stopped && this.start(), RESTART_MS);
    });
  }

  stop() {
    this.stopped = true;
    this.proc?.kill();
  }
}
