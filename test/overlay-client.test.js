import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createOverlayClient, rms, IMAGES, RECONNECT_MS } from '../public/overlay-core.js';
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

  describe('画面での再生と表示', () => {
    it('1 文を再生する: 再生中は字幕を出し、音量で口を開け、終わったら字幕を消して完了を通知する', async () => {
      await sockets.last().receive({ type: 'say', id: 1, text: 'こんにちは。', wav: WAV });
      const src = ctx.sources[0];
      expect(src.started).toBe(true);
      expect(el.sub.textContent).toBe('こんにちは。');
      expect(el.sub.classList.contains('show')).toBe(true);

      ctx.level = 0.2;
      client.lipStep();
      expect(el.char.src).toBe(IMAGES.open);
      expect(el.char.classList.contains('talk')).toBe(true);
      ctx.level = 0.01;
      client.lipStep();
      expect(el.char.src).toBe(IMAGES.closed);

      src.onended();
      expect(el.sub.classList.contains('show')).toBe(false);
      expect(sockets.last().sent).toEqual([{ type: 'ended', id: 1 }]);
      client.lipStep();
      expect(el.char.src).toBe(IMAGES.closed);
    });

    it('次の指示が来たら、再生中の音声を止めてから新しい音声を再生する', async () => {
      await sockets.last().receive({ type: 'say', id: 1, text: '一', wav: WAV });
      await sockets.last().receive({ type: 'say', id: 2, text: '二', wav: WAV });
      expect(ctx.sources[0].stopped).toBe(true);
      expect(ctx.sources[1].started).toBe(true);
      expect(el.sub.textContent).toBe('二');
      // 止めた方の終了イベントは完了として扱わない
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

  describe('立ち絵がないときの仮表示', () => {
    it('立ち絵を置いていない: 仮の図形を出し、その口を音量で開閉する', async () => {
      el.char.onerror();
      expect(el.char.style.display).toBe('none');
      expect(el.placeholder.style.display).toBe('block');
      await sockets.last().receive({ type: 'say', id: 1, text: '一', wav: WAV });
      ctx.level = 0.2;
      client.lipStep();
      expect(el.placeholder.style.props['--mouth']).toBe('40px');
      ctx.level = 0;
      client.lipStep();
      expect(el.placeholder.style.props['--mouth']).toBe('6px');
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
