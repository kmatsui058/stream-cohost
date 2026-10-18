// API キー無しで「VOICEVOX 合成 → オーバーレイ配信」を確認する。
// 実行: npm run test:voice  → OBS のブラウザソース（またはブラウザで http://127.0.0.1:8787/）を開いておくと喋る
// オーバーレイが無ければ擬似クライアントで再生完了を返して流れだけ確認する。
import WebSocket from 'ws';
import { config } from '../src/config.js';
import { Overlay } from '../src/overlay.js';
import { Speaker } from '../src/speaker.js';
import { Director } from '../src/director.js';
import { EventEmitter } from 'node:events';
import { checkVoicevox } from '../src/voicevox.js';

await checkVoicevox(config.voicevox.url);
const overlay = new Overlay(config.overlay);
overlay.start();
const speaker = new Speaker(overlay, config.voicevox);
// Gemini の代わりに出力文字起こしを細切れで流す偽物
const fake = Object.assign(new EventEmitter(), { ready: false, sendText: () => true });
new Director({ gemini: fake, speaker, cfg: { ...config.director, idleMinSec: 0 } });

await new Promise((r) => setTimeout(r, 3000)); // ブラウザソースの接続待ち
if (!overlay.hasClient) {
  const ws = new WebSocket(`ws://127.0.0.1:${config.overlay.port}`);
  ws.on('message', (raw) => {
    const m = JSON.parse(raw);
    if (m.type === 'say') {
      console.log(`[擬似クライアント] 受信 id=${m.id} wav=${m.wav.length}B64 「${m.text}」`);
      setTimeout(() => ws.send(JSON.stringify({ type: 'ended', id: m.id })), 300);
    }
  });
  await new Promise((r) => ws.on('open', r));
}

const chunks = ['こんにちは、', '相方の', 'テストです。画面', 'ちゃんと見え', 'てますか？', 'それじゃあ始めましょう'];
for (const c of chunks) {
  fake.emit('modelText', c);
  await new Promise((r) => setTimeout(r, 150));
}
fake.emit('turnComplete');
speaker.once('idle', () => {
  console.log('完了');
  setTimeout(() => process.exit(0), 300);
});
