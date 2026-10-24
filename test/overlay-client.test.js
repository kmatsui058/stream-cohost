import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createOverlayClient, rms, DIM, LEVEL_FULL, SPEAK_ON_FRAC, SPEAK_OFF_FRAC, RECONNECT_MS } from '../public/overlay-core.js';

// 明るさの幅（DIM〜1）に対する割合 f の明るさになる音量
const levelFor = (f) => LEVEL_FULL * f;
const at = (f) => DIM + (1 - DIM) * f;
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
  const brightness = () => Number(el.root.style.props['--brightness']);
  const speaking = () => el.root.classList.contains('speaking');
  const steps = (n) => {
    for (let i = 0; i < n; i++) client.levelStep();
  };
  const play = (id = 1, text = '一') => sockets.last().receive({ type: 'say', id, text, wav: WAV });

  describe('表示名と立ち絵の有無を受け取る', () => {
    it('立ち絵ありで画面が接続する: 表示名を出し、立ち絵の表示に切り替える', () => {
      sockets.last().receive({ type: 'profile', name: 'ORÐA-VÁR', character: true });
      expect(el.name.textContent).toBe('ORÐA-VÁR');
      expect(el.root.classList.contains('has-character')).toBe(true);
    });

    it('立ち絵が片方しかない: SOUND ONLY の表示にする', () => {
      sockets.last().receive({ type: 'profile', name: 'ORÐA-VÁR', character: true });
      sockets.last().receive({ type: 'profile', name: 'ORÐA-VÁR', character: false });
      expect(el.root.classList.contains('has-character')).toBe(false);
    });
  });

  describe('再生音量を変える', () => {
    it('音量の指示を受ける: 再生音量が 0.3 に向かって変わり、1 で戻る', () => {
      sockets.last().receive({ type: 'volume', level: 0.3 });
      expect(ctx.gains[0].gain.target).toBe(0.3);
      sockets.last().receive({ type: 'volume', level: 1 });
      expect(ctx.gains[0].gain.target).toBe(1);
    });
  });

  describe('召喚中だけ相方を表示する', () => {
    it('召喚と退去: 表示の指示で present が付き、非表示の指示で外れる', () => {
      expect(el.root.classList.contains('present')).toBe(false);
      sockets.last().receive({ type: 'presence', visible: true });
      expect(el.root.classList.contains('present')).toBe(true);
      sockets.last().receive({ type: 'presence', visible: false });
      expect(el.root.classList.contains('present')).toBe(false);
    });

    const awake = () => el.root.classList.contains('awake');

    it('召喚されてから話し始める: 召喚直後は awake なし（0.3）、音声の再生を始めるときに awake が付く（1）', async () => {
      sockets.last().receive({ type: 'presence', visible: true });
      expect(awake()).toBe(false);
      const p = play(1, 'はい。');
      expect(awake()).toBe(false); // まだ再生を始めていない
      await p;
      expect(ctx.sources[0].started).toBe(true);
      expect(awake()).toBe(true);
    });

    it('話し終わって次の質問を待つ: 退去するまで awake のまま', async () => {
      sockets.last().receive({ type: 'presence', visible: true });
      await play(1, 'はい。');
      ctx.sources[0].onended();
      expect(awake()).toBe(true);
    });

    it('もう一度召喚される: また awake なしから始まる', async () => {
      sockets.last().receive({ type: 'presence', visible: true });
      await play(1, 'はい。');
      sockets.last().receive({ type: 'presence', visible: false });
      sockets.last().receive({ type: 'presence', visible: true });
      expect(awake()).toBe(false);
    });

    it('召喚中に画面が接続する: 接続時の情報で表示する', () => {
      sockets.last().receive({ type: 'profile', name: 'ORÐA-VÁR', character: true, present: true });
      expect(el.root.classList.contains('present')).toBe(true);
    });
  });

  describe('立ち絵がないときの SOUND ONLY 表示', () => {
    it('立ち絵フォルダを設定していない: 起動直後は SOUND ONLY が暗い状態', () => {
      expect(el.root.classList.contains('has-character')).toBe(false);
      expect(brightness()).toBeCloseTo(DIM);
      expect(DIM).toBe(0.7);
      expect(speaking()).toBe(false);
      expect(el.sub.classList.contains('show')).toBe(false);
    });
  });

  describe('立ち絵の表示と表情', () => {
    beforeEach(() => sockets.last().receive({ type: 'profile', name: 'ORÐA-VÁR', character: true }));

    it('喋っていない: default の表情（speaking なし）で暗い', () => {
      steps(5);
      expect(speaking()).toBe(false);
      expect(brightness()).toBeCloseTo(DIM);
    });

    it('喋り始めて、喋り終わる: smile になり、暗く戻ると default に戻る', async () => {
      await play();
      ctx.level = 0.3;
      steps(5);
      expect(speaking()).toBe(true);
      ctx.sources[0].onended();
      steps(120);
      expect(speaking()).toBe(false);
      expect(brightness()).toBeCloseTo(DIM, 2);
    });

    it('音量が小さく揺れる: 一瞬だけ小さくなっても smile のまま', async () => {
      await play();
      ctx.level = 0.3;
      steps(10);
      for (let i = 0; i < 5; i++) {
        ctx.level = 0;
        client.levelStep();
        expect(speaking()).toBe(true);
        ctx.level = 0.3;
        client.levelStep();
        expect(speaking()).toBe(true);
      }
    });

    it('しきい値付近で行き来しない（smile に入る明るさと戻る明るさが違う）', async () => {
      await play();
      ctx.level = levelFor(SPEAK_ON_FRAC + 0.1); // 入るしきい値より上 → smile に入る
      steps(60);
      expect(speaking()).toBe(true);
      ctx.level = levelFor((SPEAK_ON_FRAC + SPEAK_OFF_FRAC) / 2); // 入るしきい値より下だが、戻るしきい値より上
      steps(120);
      expect(speaking()).toBe(true);
      ctx.level = 0;
      steps(120);
      expect(speaking()).toBe(false);
    });
  });

  describe('画面での再生と表示', () => {
    it('1 文を再生する: 再生中は字幕を出し、終わったら字幕を消して完了を通知する', async () => {
      await play(1, '承知しました。');
      const src = ctx.sources[0];
      expect(src.started).toBe(true);
      expect(el.sub.textContent).toBe('承知しました。');
      expect(el.sub.classList.contains('show')).toBe(true);
      src.onended();
      expect(el.sub.classList.contains('show')).toBe(false);
      expect(sockets.last().sent).toEqual([{ type: 'ended', id: 1 }]);
    });

    it('再生音量に応じて明るくなる: 音量で明るくなり、無音になると暗い状態へゆっくり戻る', async () => {
      await play();
      ctx.level = 0.3;
      steps(10);
      expect(brightness()).toBeGreaterThan(0.95);
      ctx.level = levelFor(0.5); // 中くらいの音量なら中くらいの明るさ
      steps(60);
      expect(brightness()).toBeGreaterThan(at(0.4));
      expect(brightness()).toBeLessThan(at(0.6));
      ctx.level = 0;
      client.levelStep();
      expect(brightness()).toBeGreaterThan(at(0.4)); // 1 フレームでは戻らない
      steps(120);
      expect(brightness()).toBeCloseTo(DIM, 2);
    });

    it('次の指示が来たら、再生中の音声を止めてから新しい音声を再生する', async () => {
      await play(1, '一');
      await play(2, '二');
      expect(ctx.sources[0].stopped).toBe(true);
      expect(ctx.sources[1].started).toBe(true);
      expect(el.sub.textContent).toBe('二');
      ctx.sources[0].onended?.();
      expect(sockets.last().sent).toEqual([]);
    });

    it('音声データが壊れている: 再生完了を通知する', async () => {
      ctx.failDecode = true;
      await play(3, 'x');
      expect(sockets.last().sent).toEqual([{ type: 'ended', id: 3 }]);
    });

    it('中断の指示: 再生を止めて字幕を消し、完了は通知しない', async () => {
      await play();
      sockets.last().receive({ type: 'stop' });
      expect(ctx.sources[0].stopped).toBe(true);
      expect(el.sub.classList.contains('show')).toBe(false);
      expect(client.current).toBeNull();
      expect(sockets.last().sent).toEqual([]);
    });

    it('自動再生が止められていたら再開してから再生する', async () => {
      ctx.state = 'suspended';
      await play();
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
      await play();
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
      await play();
      sockets.last().send = () => {
        throw new Error('WebSocket is already in CLOSING or CLOSED state');
      };
      expect(() => ctx.sources[0].onended()).not.toThrow();
    });
  });
});
