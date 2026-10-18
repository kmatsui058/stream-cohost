// obs-websocket-js の OBSWebSocket の偽物。connect の成否と call の応答を差し替えられる。
import { EventEmitter } from 'node:events';

export function fakeObs() {
  const client = new EventEmitter();
  client.connectResults = []; // 'ok' | Error。空なら 'ok'
  client.connectCalls = 0;
  client.calls = [];
  client.broadcastId = ''; // OBS の配信設定に入っている配信枠の動画 ID
  client.handlers = {
    GetStreamServiceSettings: async () => ({
      streamServiceType: 'rtmp_common',
      streamServiceSettings: { service: 'YouTube - RTMPS', broadcast_id: client.broadcastId },
    }),
    GetCurrentProgramScene: async () => ({ currentProgramSceneName: 'メイン' }),
    GetSourceScreenshot: async () => ({ imageData: 'data:image/jpg;base64,QUJD' }),
  };
  client.connect = async (url, password) => {
    client.connectCalls++;
    client.lastConnect = { url, password };
    const r = client.connectResults.shift() ?? 'ok';
    if (r instanceof Error) {
      // 実物と同様、失敗時は ConnectionClosed も飛ぶ
      client.emit('ConnectionClosed');
      throw r;
    }
  };
  client.call = async (method, params) => {
    client.calls.push({ method, params });
    return client.handlers[method](params);
  };
  client.disconnect = () => {};
  return client;
}
