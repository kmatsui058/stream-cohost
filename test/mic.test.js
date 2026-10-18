import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Mic, CHUNK_BYTES } from '../src/mic.js';
import { fakeSpawner } from './fakes/process.js';

describe('audio-input', () => {
  let sp;
  beforeEach(() => {
    sp = fakeSpawner();
    vi.useFakeTimers();
  });
  afterEach(() => vi.useRealTimers());

  describe('指定したマイクから音声を取り込む', () => {
    it('起動時に指定デバイスで取り込みを開始する', () => {
      new Mic({ device: 'Line (AG03)', ffmpeg: 'ffmpeg' }, sp).start();
      expect(sp.calls).toHaveLength(1);
      const { cmd, args } = sp.calls[0];
      expect(cmd).toBe('ffmpeg');
      expect(args.join(' ')).toContain('-f dshow');
      expect(args).toContain('audio=Line (AG03)');
      expect(args.join(' ')).toContain('-ac 1 -ar 16000 -f s16le -');
    });

    it('デバイス名が未設定: 開始されずエラーになる', () => {
      expect(() => new Mic({ device: '', ffmpeg: 'ffmpeg' }, sp).start()).toThrow(/MIC_DEVICE/);
      expect(sp.calls).toHaveLength(0);
    });
  });

  describe('一定の長さの断片で音声を届ける', () => {
    it('不揃いな大きさで届いたデータ: 3200 バイトずつ順序どおりに届き、余りは持ち越す', () => {
      const mic = new Mic({ device: 'd', ffmpeg: 'ffmpeg' }, sp);
      const chunks = [];
      mic.on('chunk', (c) => chunks.push(Buffer.from(c)));
      mic.start();
      const data = Buffer.from(Array.from({ length: 7000 }, (_, i) => i % 251));
      sp.last().stdout.emit('data', data.subarray(0, 1000));
      sp.last().stdout.emit('data', data.subarray(1000));
      expect(chunks).toHaveLength(2);
      expect(chunks.every((c) => c.length === CHUNK_BYTES)).toBe(true);
      expect(Buffer.concat(chunks)).toEqual(data.subarray(0, 6400));
      // 残り 600 バイト + 2600 バイトで次の断片になる
      sp.last().stdout.emit('data', Buffer.alloc(2600, 7));
      expect(chunks).toHaveLength(3);
      expect(chunks[2].subarray(0, 600)).toEqual(data.subarray(6400));
    });
  });

  describe('取り込みが止まったら自動で再開する', () => {
    it('デバイスが抜けて取り込みが終了した: 3 秒後に同じデバイスで再開する', () => {
      new Mic({ device: 'd', ffmpeg: 'ffmpeg' }, sp).start();
      sp.last().emit('exit', 1);
      vi.advanceTimersByTime(2999);
      expect(sp.calls).toHaveLength(1);
      vi.advanceTimersByTime(1);
      expect(sp.calls).toHaveLength(2);
      expect(sp.calls[1].args).toContain('audio=d');
    });

    it('終了操作による停止: 再開されない', () => {
      const mic = new Mic({ device: 'd', ffmpeg: 'ffmpeg' }, sp);
      mic.start();
      mic.stop();
      expect(sp.last().killed).toBe(true);
      vi.advanceTimersByTime(10000);
      expect(sp.calls).toHaveLength(1);
    });

    it('再開待ちの間に停止したら再開しない', () => {
      const mic = new Mic({ device: 'd', ffmpeg: 'ffmpeg' }, sp);
      mic.start();
      sp.last().emit('exit', 1);
      mic.stop();
      vi.advanceTimersByTime(10000);
      expect(sp.calls).toHaveLength(1);
    });
  });

  it('ffmpeg の標準エラーと起動エラーを記録し、例外にしない', () => {
    new Mic({ device: 'd', ffmpeg: 'ffmpeg' }, sp).start();
    expect(() => {
      sp.last().stderr.emit('data', Buffer.from('Could not find audio device'));
      sp.last().emit('error', new Error('ENOENT'));
    }).not.toThrow();
  });
});
