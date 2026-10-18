import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ObsCapture } from '../src/obs.js';
import { fakeObs } from './fakes/obs.js';

const cfg = { url: 'ws://127.0.0.1:4455', password: 'pw', frameIntervalMs: 2000, frameWidth: 960, sourceName: '' };

describe('screen-capture', () => {
  let client;
  // 画面取り込みの呼び出しだけ（配信枠の読み取りは除く）
  const shots = () => client.calls.filter((c) => c.method !== 'GetStreamServiceSettings');
  beforeEach(() => {
    client = fakeObs();
    vi.useFakeTimers();
  });
  afterEach(() => vi.useRealTimers());

  function started(c = cfg) {
    const cap = new ObsCapture(c, { client });
    const frames = [];
    cap.on('frame', (f) => frames.push(f));
    cap.start();
    return { cap, frames };
  }

  describe('配信画面を定期的に取り込む', () => {
    it('対象を指定していない: 配信中のシーンを設定した幅の JPEG で届ける', async () => {
      const { frames } = started();
      await vi.advanceTimersByTimeAsync(2000);
      expect(client.lastConnect).toEqual({ url: cfg.url, password: 'pw' });
      expect(shots().map((c) => c.method)).toEqual(['GetCurrentProgramScene', 'GetSourceScreenshot']);
      expect(shots()[1].params).toMatchObject({ sourceName: 'メイン', imageFormat: 'jpg', imageWidth: 960 });
      expect(frames).toEqual(['QUJD']);
    });

    it('対象を指定している: そのソースを取り込む', async () => {
      const { frames } = started({ ...cfg, sourceName: 'ゲーム画面' });
      await vi.advanceTimersByTimeAsync(2000);
      expect(shots().map((c) => c.method)).toEqual(['GetSourceScreenshot']);
      expect(shots()[0].params.sourceName).toBe('ゲーム画面');
      expect(frames).toHaveLength(1);
    });
  });

  describe('取り込みを重複させない', () => {
    it('取り込みが間隔より遅い: その回は行わない', async () => {
      let release;
      client.handlers.GetSourceScreenshot = () => new Promise((r) => (release = r));
      started({ ...cfg, sourceName: 's' });
      await vi.advanceTimersByTimeAsync(2000);
      await vi.advanceTimersByTimeAsync(2000);
      expect(shots()).toHaveLength(1);
      release({ imageData: 'data:image/jpg;base64,X' });
      await vi.advanceTimersByTimeAsync(2000);
      expect(shots()).toHaveLength(2);
    });
  });

  describe('配信ソフトとの接続を自動で回復する', () => {
    it('接続が切れた: 5 秒後に再接続し、それまでは取り込まない', async () => {
      const { frames } = started();
      await vi.advanceTimersByTimeAsync(0);
      client.emit('ConnectionClosed');
      await vi.advanceTimersByTimeAsync(4999);
      expect(client.connectCalls).toBe(1);
      expect(frames).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(1);
      expect(client.connectCalls).toBe(2);
      await vi.advanceTimersByTimeAsync(2000);
      expect(frames.length).toBeGreaterThan(0);
    });

    it('起動時に配信ソフトが起動していない: 5 秒ごとに再試行し、接続後に取り込みを始める', async () => {
      client.connectResults = [new Error('ECONNREFUSED'), new Error('ECONNREFUSED')];
      const { frames } = started();
      await vi.advanceTimersByTimeAsync(0);
      expect(client.connectCalls).toBe(1);
      await vi.advanceTimersByTimeAsync(5000);
      expect(client.connectCalls).toBe(2);
      expect(frames).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(5000);
      expect(client.connectCalls).toBe(3);
      await vi.advanceTimersByTimeAsync(2000);
      expect(frames.length).toBeGreaterThan(0);
    });

    it('接続失敗と切断イベントが重なっても、再接続の予約は 1 つだけ', async () => {
      client.connectResults = [new Error('ECONNREFUSED')];
      started();
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(5000);
      expect(client.connectCalls).toBe(2);
      await vi.advanceTimersByTimeAsync(20000);
      expect(client.connectCalls).toBe(2);
    });

    it('停止したら再接続しない', async () => {
      const { cap } = started();
      await vi.advanceTimersByTimeAsync(0);
      cap.stop();
      client.emit('ConnectionClosed');
      await vi.advanceTimersByTimeAsync(20000);
      expect(client.connectCalls).toBe(1);
    });
  });

  describe('live-chat / OBS で選んだ配信枠を読み取る', () => {
    const watch = () => {
      const { cap } = started();
      const ids = [];
      cap.on('broadcast', (id) => ids.push(id));
      return ids;
    };

    it('起動時に配信枠が選ばれている: その動画 ID を知らせる', async () => {
      client.broadcastId = 'w_ObNDWnWC4';
      const ids = watch();
      await vi.advanceTimersByTimeAsync(0);
      expect(ids).toEqual(['w_ObNDWnWC4']);
    });

    it('配信枠を選び直す: 15 秒以内に新しい動画 ID を 1 回だけ知らせる', async () => {
      client.broadcastId = 'v1';
      const ids = watch();
      await vi.advanceTimersByTimeAsync(0);
      client.broadcastId = 'v2';
      await vi.advanceTimersByTimeAsync(15000);
      expect(ids).toEqual(['v1', 'v2']);
      await vi.advanceTimersByTimeAsync(60000);
      expect(ids).toEqual(['v1', 'v2']);
    });

    it('配信枠が選ばれていない: 何も知らせない', async () => {
      const ids = watch();
      await vi.advanceTimersByTimeAsync(60000);
      expect(ids).toEqual([]);
    });

    it('配信を開始する: 15 秒を待たずに読み取る', async () => {
      const ids = watch();
      await vi.advanceTimersByTimeAsync(0);
      client.broadcastId = 'v3';
      client.emit('StreamStateChanged', { outputActive: true, outputState: 'OBS_WEBSOCKET_OUTPUT_STARTED' });
      await vi.advanceTimersByTimeAsync(0);
      expect(ids).toEqual(['v3']);
    });

    it('読み取りに失敗しても止まらず、何も知らせない', async () => {
      client.handlers.GetStreamServiceSettings = async () => {
        throw new Error('boom');
      };
      const ids = watch();
      await vi.advanceTimersByTimeAsync(30000);
      expect(ids).toEqual([]);
    });
  });

  describe('取り込みの失敗で止まらない', () => {
    it('対象のソースが存在しない: 届けず、次の間隔で再試行する', async () => {
      client.handlers.GetSourceScreenshot = async () => {
        throw new Error('No source was found');
      };
      const { frames } = started({ ...cfg, sourceName: 'なし' });
      await vi.advanceTimersByTimeAsync(4000);
      expect(frames).toHaveLength(0);
      expect(shots()).toHaveLength(2);
    });
  });
});
