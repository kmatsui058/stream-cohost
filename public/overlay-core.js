// 配信に重ねる画面のロジック。ブラウザ（OBS のブラウザソース）で動き、テストでは偽物を渡して動かす。
//
// サーバーから {type:'say', id, text, wav(base64)} を受けたら再生し、終わったら {type:'ended', id} を返す。
// {type:'stop'} で再生中の音声を止める。{type:'profile', name} で表示名を受け取る。
// 立ち絵は使わず、左下の SOUND ONLY 表示の明るさで「喋っている」ことを伝える。

export const DIM = 0.35; // 喋っていないときの明るさ
export const LEVEL_FULL = 0.15; // この RMS 以上で明るさ 100%
export const ATTACK = 0.5; // 明るくなるときの追従の速さ（1 フレームあたり）
export const RELEASE = 0.08; // 暗くなるときの追従の速さ（ゆっくり戻す）
export const RECONNECT_MS = 2000;

export function rms(samples) {
  let s = 0;
  for (const v of samples) s += v * v;
  return Math.sqrt(s / samples.length);
}

function base64ToArrayBuffer(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}

/**
 * @param {object} deps
 * @param {AudioContext} deps.audioContext
 * @param {() => WebSocket} deps.connect  サーバーへの WebSocket を開く関数
 * @param {{panel: HTMLElement, name: HTMLElement, sub: HTMLElement, status: HTMLElement}} deps.elements
 * @param {(fn: Function, ms: number) => unknown} [deps.schedule]  再接続の予約（既定 setTimeout）
 */
export function createOverlayClient({ audioContext: ctx, connect: openSocket, elements: el, schedule = setTimeout }) {
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 512;
  analyser.connect(ctx.destination);
  const samples = new Float32Array(analyser.fftSize);
  let brightness = DIM;
  let current = null; // { id, src }
  let ws = null;

  function send(msg) {
    try {
      ws?.send(JSON.stringify(msg));
    } catch {
      // 切断中は送れない。サーバー側は尺 + 3 秒で先に進む
    }
  }

  // 毎フレーム呼ぶ（requestAnimationFrame から）。再生音量を明るさに変換して滑らかに追従させる
  function levelStep() {
    let target = DIM;
    if (current) {
      analyser.getFloatTimeDomainData(samples);
      target = DIM + (1 - DIM) * Math.min(1, rms(samples) / LEVEL_FULL);
    }
    brightness += (target - brightness) * (target > brightness ? ATTACK : RELEASE);
    el.panel.style.setProperty('--brightness', brightness.toFixed(3));
    el.panel.classList.toggle('speaking', brightness > DIM + 0.05);
  }

  function stopCurrent() {
    if (!current) return;
    try {
      current.src.onended = null;
      current.src.stop();
    } catch {}
    current = null;
    el.sub.classList.remove('show');
  }

  async function say({ id, text, wav }) {
    stopCurrent();
    try {
      if (ctx.state === 'suspended') await ctx.resume();
      const buf = await ctx.decodeAudioData(base64ToArrayBuffer(wav));
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.connect(analyser);
      current = { id, src };
      el.sub.textContent = text;
      el.sub.classList.add('show');
      src.onended = () => {
        if (current?.id !== id) return;
        current = null;
        el.sub.classList.remove('show');
        send({ type: 'ended', id });
      };
      src.start();
    } catch (err) {
      console.error(err);
      send({ type: 'ended', id }); // 再生できなくても完了扱いにしてサーバーを先に進める
    }
  }

  function start() {
    ws = openSocket();
    ws.onopen = () => (el.status.textContent = '');
    ws.onmessage = (e) => {
      let m;
      try {
        m = JSON.parse(e.data);
      } catch {
        return;
      }
      if (m.type === 'say') return say(m);
      if (m.type === 'stop') stopCurrent();
      if (m.type === 'profile') el.name.textContent = m.name ?? '';
    };
    // サーバー未起動・再起動時は赤字で表示して再接続（配信に映るのが嫌なら #status を消してよい）
    ws.onclose = () => {
      el.status.textContent = 'cohost: 未接続';
      stopCurrent();
      schedule(start, RECONNECT_MS);
    };
  }

  levelStep(); // 起動直後から暗い状態にする
  return { start, levelStep, say, get current() { return current; } };
}
