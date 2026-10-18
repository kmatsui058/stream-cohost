import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createOverlayClient, rms, DIM, RECONNECT_MS } from '../public/overlay-core.js';
import { fakeAudioContext, fakeSocketFactory, fakeElements } from './fakes/browser.js';

const WAV = Buffer.from('RIFF....').toString('base64');

describe('stream-overlay（画面側）', () => {
  let ctx, sockets, el, schedule, client;
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    ctx = fakeAudioContext();
    sockets = fakeSocketFactory();
    el = fakeElements();
    schedule = vi.fn();
    client = createOverlayClient({ audioContext: ctx, connect: sockets.connect, elements: el, schedule });
    client.start();
  });
  const brightness = () => Number(el.panel.style.props['--brightness']);
  const steps = (n) => {
    for (let i = 0; i < n; i++) client.levelStep();
  };

  describe('SOUND ONLY 表示', () => {
    it('起動直後: 暗い状態で、字幕は出ていない', () => {
      client.levelStep();
      expect(brightness()).toBeCloseTo(DIM);
      expect(DIM).toBe(0.35);
      expect(el.panel.classList.contains('speaking')).toBe(false);
      expect(el.sub.classList.contains('show')).toBe(false);
    });
  });

  describe('表示名を受け取る', () => {
    it('画面が接続する: 受け取った表示名を出す', () => {
      sockets.last().receive({ type: 'profile', name: 'ORÐA-VÁR' });
      expect(el.name.textContent).toBe('ORÐA-VÁR');
    });
  });

  describe('画面での再生と表示', () => {
    it('1 文を再生する: 再生中は字幕を出し、終わったら字幕を消して完了を通知する', async () => {
      await sockets.last().receive({ type: 'say', id: 1, text: '承知しました。', wav: WAV });
      const src = ctx.sources[0];
      expect(src.started).toBe(true);
      expect(el.sub.textContent).toBe('承知しました。');
      expect(el.sub.classList.contains('show')).toBe(true);
      src.onended();
      expect(el.sub.classList.contains('show')).toBe(false);
      expect(sockets.last().sent).toEqual([{ type: 'ended', id: 1 }]);
    });

    it('再生音量に応じて明るくなる: 音量で明るくなり、無音になると暗い状態へゆっくり戻る', async () => {
      await sockets.last().receive({ type: 'say', id: 1, text: '一', wav: WAV });
      ctx.level = 0.3; // 十分大きい音
      steps(10);
      expect(brightness()).toBeGreaterThan(0.95);
      expect(el.panel.classList.contains('speaking')).toBe(true);
      // 中くらいの音量なら中くらいの明るさ
      ctx.level = 0.075;
      steps(60);
      expect(brightness()).toBeGreaterThan(0.6);
      expect(brightness()).toBeLessThan(0.75);
      // 無音: 1 フレームでは戻らず、ゆっくり暗くなる
      ctx.level = 0;
      client.levelStep();
      expect(brightness()).toBeGreaterThan(0.6);
      steps(120);
      expect(brightness()).toBeCloseTo(DIM, 2);
      expect(el.panel.classList.contains('speaking')).toBe(false);
    });

    it('再生が終わったら、音量に関係なく暗い状態へ戻る', async () => {
      await sockets.last().receive({ type: 'say', id: 1, text: '一', wav: WAV });
      ctx.level = 0.3;
      steps(10);
      ctx.sources[0].onended();
      steps(120);
      expect(brightness()).toBeCloseTo(DIM, 2);
    });

    it('次の指示が来たら、再生中の音声を止めてから新しい音声を再生する', async () => {
      await sockets.last().receive({ type: 'say', id: 1, text: '一', wav: WAV });
      await sockets.last().receive({ type: 'say', id: 2, text: '二', wav: WAV });
      expect(ctx.sources[0].stopped).toBe(true);
      expect(ctx.sources[1].started).toBe(true);
      expect(el.sub.textContent).toBe('二');
      ctx.sources[0].onended?.();
      expect(sockets.last().sent).toEqual([]);
    });

    it('音声データが壊れている: 再生完了を通知する', async () => {
      ctx.failDecode = true;
      await sockets.last().receive({ type: 'say', id: 3, text: 'x', wav: WAV });
      expect(sockets.last().sent).toEqual([{ type: 'ended', id: 3 }]);
    });

    it('中断の指示: 再生を止めて字幕を消し、完了は通知しない', async () => {
      await sockets.last().receive({ type: 'say', id: 1, text: '一', wav: WAV });
      sockets.last().receive({ type: 'stop' });
      expect(ctx.sources[0].stopped).toBe(true);
      expect(el.sub.classList.contains('show')).toBe(false);
      expect(client.current).toBeNull();
      expect(sockets.last().sent).toEqual([]);
    });

    it('自動再生が止められていたら再開してから再生する', async () => {
      ctx.state = 'suspended';
      await sockets.last().receive({ type: 'say', id: 1, text: '一', wav: WAV });
      expect(ctx.state).toBe('running');
      expect(ctx.sources[0].started).toBe(true);
    });

    it('不正なメッセージは無視する', () => {
      expect(() => sockets.last().receive('not json')).not.toThrow();
    });

    it('rms: 音量の実効値を計算する', () => {
      expect(rms(new Float32Array([0.5, -0.5, 0.5, -0.5]))).toBeCloseTo(0.5);
      expect(rms(new Float32Array([0, 0]))).toBe(0);
    });
  });

  describe('接続を自動で回復する', () => {
    it('制御側を再起動した: 未接続と表示し、再生を止め、2 秒後に再接続して表示を消す', async () => {
      await sockets.last().receive({ type: 'say', id: 1, text: '一', wav: WAV });
      sockets.last().onclose();
      expect(el.status.textContent).toBe('cohost: 未接続');
      expect(ctx.sources[0].stopped).toBe(true);
      expect(schedule).toHaveBeenCalledWith(expect.any(Function), RECONNECT_MS);
      schedule.mock.calls[0][0]();
      expect(sockets.sockets).toHaveLength(2);
      sockets.last().onopen();
      expect(el.status.textContent).toBe('');
    });

    it('切断中に再生が終わっても例外にしない', async () => {
      await sockets.last().receive({ type: 'say', id: 1, text: '一', wav: WAV });
      sockets.last().send = () => {
        throw new Error('WebSocket is already in CLOSING or CLOSED state');
      };
      expect(() => ctx.sources[0].onended()).not.toThrow();
    });
  });
});
