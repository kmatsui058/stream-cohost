// 配信に重ねる画面のロジック。ブラウザ（OBS のブラウザソース）で動き、テストでは偽物を渡して動かす。
//
// サーバーから {type:'say', id, text, wav(base64)} を受けたら再生し、終わったら {type:'ended', id} を返す。
// {type:'stop'} で再生中の音声を止める。口パクは再生音量（RMS）がしきい値を超えたら「開」にするだけの簡易方式。

export const IMAGES = { closed: '/char/closed.png', open: '/char/open.png' };
export const MOUTH_THRESHOLD = 0.04;
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
 * @param {{char: HTMLImageElement, placeholder: HTMLElement, sub: HTMLElement, status: HTMLElement}} deps.elements
 * @param {(fn: Function, ms: number) => unknown} [deps.schedule]  再接続の予約（既定 setTimeout）
 */
export function createOverlayClient({ audioContext: ctx, connect: openSocket, elements: el, schedule = setTimeout }) {
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 512;
  analyser.connect(ctx.destination);
  const samples = new Float32Array(analyser.fftSize);
  let usePlaceholder = false;
  let current = null; // { id, src }
  let ws = null;

  // 立ち絵が読み込めなければ仮の図形に切り替える
  el.char.onerror = () => {
    usePlaceholder = true;
    el.char.style.display = 'none';
    el.placeholder.style.display = 'block';
  };
  el.char.src = IMAGES.closed;

  function send(msg) {
    try {
      ws?.send(JSON.stringify(msg));
    } catch {
      // 切断中は送れない。サーバー側は尺 + 3 秒で先に進む
    }
  }

  function setMouth(open) {
    if (usePlaceholder) el.placeholder.style.setProperty('--mouth', open ? '40px' : '6px');
    else {
      const want = open ? IMAGES.open : IMAGES.closed;
      if (!el.char.src.endsWith(want)) el.char.src = want;
    }
    el.char.classList.toggle('talk', open);
  }

  // 毎フレーム呼ぶ（requestAnimationFrame から）
  function lipStep() {
    if (current) {
      analyser.getFloatTimeDomainData(samples);
      setMouth(rms(samples) > MOUTH_THRESHOLD);
    } else setMouth(false);
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
    };
    // サーバー未起動・再起動時は赤字で表示して再接続（配信に映るのが嫌なら #status を消してよい）
    ws.onclose = () => {
      el.status.textContent = 'cohost: 未接続';
      stopCurrent();
      schedule(start, RECONNECT_MS);
    };
  }

  return { start, lipStep, say, get current() { return current; } };
}
