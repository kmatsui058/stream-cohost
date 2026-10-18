// 画面側（overlay-core.js）用の偽物: AudioContext、WebSocket、DOM 要素。

export function fakeAudioContext() {
  const ctx = {
    state: 'running',
    destination: {},
    level: 0, // 再生音量（getFloatTimeDomainData が返すサンプル値）
    failDecode: false,
    sources: [],
    resume: async () => {
      ctx.state = 'running';
    },
    createAnalyser: () => ({
      fftSize: 2048,
      connect() {},
      getFloatTimeDomainData: (arr) => arr.fill(ctx.level),
    }),
    decodeAudioData: async (buf) => {
      if (ctx.failDecode) throw new Error('EncodingError: Unable to decode audio data');
      return { byteLength: buf.byteLength };
    },
    createBufferSource: () => {
      const src = { started: false, stopped: false, onended: null, connect() {}, start() { src.started = true; }, stop() { src.stopped = true; } };
      ctx.sources.push(src);
      return src;
    },
  };
  return ctx;
}

export function fakeSocketFactory() {
  const sockets = [];
  const connect = () => {
    const ws = {
      sent: [],
      send(s) {
        ws.sent.push(JSON.parse(s));
      },
      receive(m) {
        return ws.onmessage({ data: typeof m === 'string' ? m : JSON.stringify(m) });
      },
    };
    sockets.push(ws);
    return ws;
  };
  return { connect, sockets, last: () => sockets.at(-1) };
}

function classList() {
  const set = new Set();
  return {
    add: (c) => set.add(c),
    remove: (c) => set.delete(c),
    toggle: (c, on) => (on ? set.add(c) : set.delete(c)),
    contains: (c) => set.has(c),
  };
}

export function fakeElements() {
  const el = () => {
    const props = {};
    return { textContent: '', classList: classList(), style: { setProperty: (k, v) => (props[k] = v), props } };
  };
  return { root: el(), name: el(), sub: el(), status: el() };
}
