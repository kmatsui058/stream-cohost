// マイク入力: ffmpeg (DirectShow) で 16kHz / mono / s16le の生 PCM を stdout に出させて読む。
// Gemini Live の音声入力仕様が「16bit PCM 16kHz little-endian」なのでそのまま送れる。
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { logger } from './log.js';

const log = logger('mic');
const CHUNK_BYTES = 3200; // 100ms 分 (16000Hz * 2byte * 0.1s)

export class Mic extends EventEmitter {
  constructor({ device, ffmpeg }) {
    super();
    this.device = device;
    this.ffmpeg = ffmpeg;
    this.proc = null;
    this.stopped = false;
  }

  start() {
    if (!this.device) throw new Error('MIC_DEVICE が未設定です（npm run mics で確認）');
    this.stopped = false;
    const args = ['-hide_banner', '-loglevel', 'error', '-f', 'dshow', '-audio_buffer_size', '50',
      '-i', `audio=${this.device}`, '-ac', '1', '-ar', '16000', '-f', 's16le', '-'];
    log.info(`ffmpeg 起動: ${this.device}`);
    this.proc = spawn(this.ffmpeg, args, { stdio: ['ignore', 'pipe', 'pipe'] });

    let buf = Buffer.alloc(0);
    this.proc.stdout.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      while (buf.length >= CHUNK_BYTES) {
        this.emit('chunk', buf.subarray(0, CHUNK_BYTES));
        buf = buf.subarray(CHUNK_BYTES);
      }
    });
    this.proc.stderr.on('data', (d) => log.warn(d.toString().trim()));
    this.proc.on('error', (e) => log.error('ffmpeg を起動できません', e));
    this.proc.on('exit', (code) => {
      log.warn(`ffmpeg 終了 code=${code}`);
      this.proc = null;
      // デバイス抜けなどで落ちたら 3 秒後に再起動
      if (!this.stopped) setTimeout(() => this.start(), 3000);
    });
  }

  stop() {
    this.stopped = true;
    this.proc?.kill();
  }
}
