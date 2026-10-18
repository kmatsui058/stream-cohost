// @google/genai の ai.live.connect の偽物。
// 実物と同じく { model, config, callbacks } を受け取り、Session（sendRealtimeInput / close）を返す。
// サーバーからのメッセージは LiveServerMessage と同じ形で session.receive() に渡す。
export function fakeLiveAi() {
  const sessions = [];
  const ai = {
    failures: [], // connect を失敗させる回数分 Error を積む
    live: {
      connect: async (params) => {
        const err = ai.failures.shift();
        if (err) throw err;
        const s = {
          params,
          sent: [],
          closed: false,
          throwOnSend: false,
          sendRealtimeInput(p) {
            if (s.throwOnSend) throw new Error('socket is not open');
            s.sent.push(p);
          },
          close() {
            if (s.closed) return;
            s.closed = true;
            params.callbacks.onclose?.({ code: 1000, reason: '' });
          },
          receive(m) {
            params.callbacks.onmessage(m);
          },
          drop(code = 1011, reason = 'internal error') {
            s.closed = true;
            params.callbacks.onclose?.({ code, reason });
          },
        };
        sessions.push(s);
        return s;
      },
    },
  };
  return { ai, sessions, last: () => sessions.at(-1) };
}
