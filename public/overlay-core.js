// 配信に重ねる画面のロジック。ブラウザ（OBS のブラウザソース）で動き、テストでは偽物を渡して動かす。
//
// サーバーから {type:'say', id, text, wav(base64)} を受けたら再生し、終わったら {type:'ended', id} を返す。
// {type:'stop'} で再生中の音声を止める。{type:'volume', level} で再生音量をなめらかに変える。{type:'profile', name, character, present} で表示名と立ち絵の有無を受け取る。
// {type:'presence', visible} で相方を出す／消す（root の present クラス → CSS で表示を切り替え）。
// 召喚直後は薄く出し、最初の音声を再生する直前に root に awake を付けてはっきりさせる（退去まで付けたまま）。
// {type:'thinking', on, summon} の間は root に thinking（召喚直後なら thinking-summon も）を付け（考え中の表情）、再生中でなければ字幕の位置に「…」を出す。
// 喋っていることは、表示の明るさ（--brightness）と、立ち絵の表情（root の speaking クラス → CSS で smile に切り替え）で伝える。

export const DIM = 0.7; // 喋っていないときの明るさ（少し暗い）
export const LEVEL_FULL = 0.15; // この RMS 以上で明るさ 100%
export const ATTACK = 0.5; // 明るくなるときの追従の速さ（1 フレームあたり）
export const RELEASE = 0.08; // 暗くなるときの追従の速さ（ゆっくり戻す）
// 表情の切り替えのしきい値（明るさの幅 DIM〜1 に対する割合）。入る明るさと戻る明るさを変えて、
// 音量の細かな揺れで行き来しないようにする
export const SPEAK_ON_FRAC = 0.25;
export const SPEAK_OFF_FRAC = 0.1;
const SPEAK_ON = DIM + (1 - DIM) * SPEAK_ON_FRAC;
const SPEAK_OFF = DIM + (1 - DIM) * SPEAK_OFF_FRAC;
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
 * @param {{root: HTMLElement, name: HTMLElement, sub: HTMLElement, status: HTMLElement}} deps.elements
 * @param {(fn: Function, ms: number) => unknown} [deps.schedule]  再接続の予約（既定 setTimeout）
 */
export function createOverlayClient({ audioContext: ctx, connect: openSocket, elements: el, schedule = setTimeout }) {
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 512;
  // 再生音量（配信者と声がかぶったときに小さくする）。明るさは音量を変える前の音で決める
  const gain = ctx.createGain();
  analyser.connect(gain);
  gain.connect(ctx.destination);
  const samples = new Float32Array(analyser.fftSize);
  let brightness = DIM;
  let speaking = false;
  let current = null; // { id, src }
  let ws = null;
  let thinking = false; // 考え中（答える役に問い合わせ中）

  // 考え中で、再生中の字幕がなければ、字幕の位置に点滅する「…」を出す（CSS の .loading）
  function updateLoading() {
    if (current) return;
    const on = thinking;
    if (on) el.sub.textContent = '';
    el.sub.classList.toggle('loading', on);
    el.sub.classList.toggle('show', on);
  }

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
    if (!speaking && brightness > SPEAK_ON) speaking = true;
    else if (speaking && brightness < SPEAK_OFF) speaking = false;
    el.root.style.setProperty('--brightness', brightness.toFixed(3));
    el.root.classList.toggle('speaking', speaking);
  }

  function stopCurrent() {
    if (!current) return;
    try {
      current.src.onended = null;
      current.src.stop();
    } catch {}
    current = null;
    el.sub.classList.remove('show');
    updateLoading();
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
      el.root.classList.add('awake'); // 話し始める直前にはっきり表示する
      el.sub.classList.remove('loading');
      el.sub.textContent = text;
      el.sub.classList.add('show');
      src.onended = () => {
        if (current?.id !== id) return;
        current = null;
        el.sub.classList.remove('show');
        updateLoading();
        send({ type: 'ended', id });
      };
      src.start();
    } catch (err) {
      console.error(err);
      send({ type: 'ended', id }); // 再生できなくても完了扱いにしてサーバーを先に進める
    }
  }

  function setThinking(on, summon) {
    thinking = on;
    el.root.classList.toggle('thinking', on);
    el.root.classList.toggle('thinking-summon', on && summon);
    updateLoading();
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
      if (m.type === 'volume') gain.gain.setTargetAtTime(m.level, ctx.currentTime, 0.05);
      if (m.type === 'profile') {
        el.name.textContent = m.name ?? '';
        el.root.classList.toggle('has-character', !!m.character);
        el.root.classList.toggle('present', !!m.present);
        el.root.style.setProperty('--summon-opacity', String(m.summonOpacity ?? 1));
        el.root.classList.toggle('has-face-summon', !!m.thinkingFaces?.summon);
        el.root.classList.toggle('has-face-ask', !!m.thinkingFaces?.ask);
        setThinking(!!m.thinking, !!m.thinkingSummon);
      }
      if (m.type === 'thinking') setThinking(!!m.on, !!m.summon);
      if (m.type === 'presence') {
        el.root.classList.toggle('present', !!m.visible);
        el.root.classList.remove('awake'); // 召喚し直したら、また薄い表示から始める
      }
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
