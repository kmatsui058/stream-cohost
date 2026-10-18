import fs from 'node:fs';
import { EventEmitter } from 'node:events';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Speaker } from '../src/speaker.js';
import { logFilePath } from '../src/log.js';
import { silentWav } from './fakes/wav.js';

const vv = { url: 'http://vv', speaker: 3, speedScale: 1.15 };

function fakeOverlay() {
  const o = new EventEmitter();
  o.hasClient = true;
  o.sent = [];
  o.broadcast = (m) => o.sent.push(m);
  o.says = () => o.sent.filter((m) => m.type === 'say').map((m) => m.text);
  o.end = (id) => o.emit('ended', id ?? o.sent.filter((m) => m.type === 'say').at(-1).id);
  return o;
}

// 合成をテスト側で個別に完了・失敗させられる偽物
function controllableSynth() {
  const pending = [];
  const synth = vi.fn((text) => new Promise((resolve, reject) => pending.push({ text, resolve, reject })));
  synth.resolve = (text, sec = 1) => pending.find((p) => p.text === text).resolve(silentWav(sec));
  synth.reject = (text, e) => pending.find((p) => p.text === text).reject(e);
  return synth;
}

const tick = () => vi.advanceTimersByTimeAsync(0);

describe('speech-output', () => {
  let overlay;
  beforeEach(() => {
    vi.useFakeTimers();
    overlay = fakeOverlay();
  });
  afterEach(() => vi.useRealTimers());

  describe('文を音声合成する', () => {
    it('文を合成する: 設定で合成し、その WAV を再生に使う', async () => {
      const wav = silentWav(1);
      const synth = vi.fn(async () => wav);
      new Speaker(overlay, vv, { synthesize: synth }).push('  こんにちは。 ');
      await tick();
      expect(synth).toHaveBeenCalledWith('こんにちは。', vv);
      expect(overlay.sent[0]).toEqual({ type: 'say', id: 1, text: 'こんにちは。', wav: wav.toString('base64') });
    });

    it('空白だけの文: 合成しない', async () => {
      const synth = vi.fn();
      new Speaker(overlay, vv, { synthesize: synth }).push(' \n ');
      await tick();
      expect(synth).not.toHaveBeenCalled();
    });
  });

  describe('順番どおりに 1 文ずつ再生する', () => {
    it('3 文が続けて回される: 合成はすぐ始まり、再生は完了を待って 1 文ずつ', async () => {
      const synth = controllableSynth();
      const sp = new Speaker(overlay, vv, { synthesize: synth });
      sp.push('一。');
      sp.push('二。');
      sp.push('三。');
      expect(synth).toHaveBeenCalledTimes(3);
      synth.resolve('三。');
      synth.resolve('二。');
      await tick();
      expect(overlay.says()).toEqual([]); // 1 文目の合成待ち
      synth.resolve('一。');
      await tick();
      expect(overlay.says()).toEqual(['一。']);
      overlay.end();
      await tick();
      expect(overlay.says()).toEqual(['一。', '二。']);
      overlay.end();
      await tick();
      expect(overlay.says()).toEqual(['一。', '二。', '三。']);
    });

    it('再生完了が届かない: 長さ 2 秒の文なら 5 秒後に次へ進む', async () => {
      const synth = controllableSynth();
      const sp = new Speaker(overlay, vv, { synthesize: synth });
      sp.push('長い。');
      sp.push('次。');
      synth.resolve('長い。', 2);
      synth.resolve('次。');
      await tick();
      await vi.advanceTimersByTimeAsync(4999);
      expect(overlay.says()).toEqual(['長い。']);
      await vi.advanceTimersByTimeAsync(1);
      expect(overlay.says()).toEqual(['長い。', '次。']);
    });

    it('別の文の再生完了通知は無視する', async () => {
      const sp = new Speaker(overlay, vv, { synthesize: async () => silentWav(1) });
      sp.push('一。');
      sp.push('二。');
      await tick();
      overlay.end(999);
      await tick();
      expect(overlay.says()).toEqual(['一。']);
    });
  });

  describe('合成の失敗で止まらない', () => {
    it('2 文目の合成が失敗する: 1 文目と 3 文目を再生し、失敗を記録する', async () => {
      const synth = controllableSynth();
      const sp = new Speaker(overlay, vv, { synthesize: synth });
      sp.push('一。');
      sp.push('二。');
      sp.push('三。');
      synth.resolve('一。');
      synth.reject('二。', new Error('audio_query 500'));
      synth.resolve('三。');
      await tick();
      overlay.end();
      await tick();
      expect(overlay.says()).toEqual(['一。', '三。']);
      vi.useRealTimers();
      await new Promise((r) => setTimeout(r, 50));
      expect(fs.readFileSync(logFilePath(), 'utf8')).toMatch(/合成失敗「二。」 audio_query 500/);
    });
  });

  describe('発話を中断する', () => {
    it('再生中に中断する: 止めて、2 文目以降は再生しない', async () => {
      const sp = new Speaker(overlay, vv, { synthesize: async () => silentWav(1) });
      sp.push('一。');
      sp.push('二。');
      await tick();
      sp.stop();
      expect(overlay.sent.at(-1)).toEqual({ type: 'stop' });
      await vi.advanceTimersByTimeAsync(10_000);
      expect(overlay.says()).toEqual(['一。']);
      expect(sp.speaking).toBe(false);
    });

    it('合成待ちの間に中断し、すぐに次の文が来る: 新しい文だけを再生する', async () => {
      const synth = controllableSynth();
      const sp = new Speaker(overlay, vv, { synthesize: synth });
      sp.push('古い。');
      await tick();
      sp.stop();
      sp.push('新しい。');
      synth.resolve('古い。');
      synth.resolve('新しい。');
      await tick();
      await vi.advanceTimersByTimeAsync(10_000);
      expect(overlay.says()).toEqual(['新しい。']);
    });

    it('何も喋っていないときの中断は何もしない', () => {
      const sp = new Speaker(overlay, vv, { synthesize: vi.fn() });
      sp.stop();
      expect(overlay.sent).toEqual([]);
    });
  });

  describe('発話の開始と終了を知らせる', () => {
    it('1 文を再生し終えた: 開始と終了が 1 回ずつ', async () => {
      const sp = new Speaker(overlay, vv, { synthesize: async () => silentWav(1) });
      const events = [];
      sp.on('start', () => events.push('start'));
      sp.on('idle', () => events.push('idle'));
      sp.push('一。');
      expect(sp.speaking).toBe(true);
      await tick();
      overlay.end();
      await tick();
      expect(events).toEqual(['start', 'idle']);
      expect(sp.speaking).toBe(false);
    });

    it('中断したときも終了を 1 回だけ知らせる', async () => {
      const sp = new Speaker(overlay, vv, { synthesize: async () => silentWav(1) });
      const events = [];
      sp.on('start', () => events.push('start'));
      sp.on('idle', () => events.push('idle'));
      sp.push('一。');
      await tick();
      sp.stop();
      await vi.advanceTimersByTimeAsync(10_000);
      expect(events).toEqual(['start', 'idle']);
    });
  });

  describe('再生先が無いことを警告する', () => {
    it('画面が未接続: 音が出ていない旨を記録する', async () => {
      overlay.hasClient = false;
      new Speaker(overlay, vv, { synthesize: async () => silentWav(1) }).push('一。');
      await tick();
      vi.useRealTimers();
      await new Promise((r) => setTimeout(r, 50));
      expect(fs.readFileSync(logFilePath(), 'utf8')).toMatch(/WARN .*オーバーレイ未接続/);
    });
  });
});
