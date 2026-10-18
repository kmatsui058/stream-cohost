// エントリポイント: 各部品を起動して配線する。コンソールからの操作もここ。
import readline from 'node:readline';
import { loadConfig, missingRequired } from './config.js';
import { logger } from './log.js';
import { Mic } from './mic.js';
import { ObsCapture } from './obs.js';
import { GoogleGenAI } from '@google/genai';
import { GeminiLive } from './gemini.js';
import { Memory } from './memory.js';
import { Overlay } from './overlay.js';
import { Speaker } from './speaker.js';
import { Director } from './director.js';
import { YouTubeChat } from './youtube.js';
import { checkVoicevox } from './voicevox.js';

const log = logger('main');

const config = loadConfig();
const missing = missingRequired(config);
if (missing.length) {
  log.error(`必須の設定が .env にありません: ${missing.join(', ')}`);
  process.exit(1);
}

await checkVoicevox(config.voicevox.url);

const overlay = new Overlay(config.overlay);
overlay.start();

const ai = new GoogleGenAI({ apiKey: config.gemini.apiKey });
const gemini = new GeminiLive(config.gemini, ai);
const memory = new Memory({ ai, persona: config.gemini.persona, ...config.memory });
gemini.memory = memory;
const speaker = new Speaker(overlay, config.voicevox);
const director = new Director({ gemini, speaker, memory, cfg: config.director });

// コンテキストが大きくなったら、場が空いたタイミングで要約して張り直す
setInterval(() => {
  const limit = config.memory.rotateAtTokens;
  if (limit && gemini.ready && gemini.promptTokens > limit && director.quiet && Date.now() > gemini.nextRotateAt) {
    gemini.rotate(`コンテキスト ${gemini.promptTokens} > ${limit}`);
  }
}, 2000);

const mic = new Mic(config.mic);
mic.on('chunk', (pcm) => {
  if (director.paused) return;
  if (config.director.gateMicWhileSpeaking && speaker.speaking) return;
  gemini.sendAudio(pcm);
});

const obs = new ObsCapture(config.obs);
obs.on('frame', (jpeg) => {
  if (!director.paused) gemini.sendFrame(jpeg);
});

const chat = new YouTubeChat(config.youtube);
chat.on('messages', (msgs) => director.addChat(msgs));

await gemini.connect();
mic.start();
obs.start();
chat.start(config.youtube.videoId);

// ---- コンソール操作 ----
const HELP = `操作: p=一時停止/再開  s=今の発話をスキップ  t <文>=テキストで話しかける  v <動画ID>=チャット対象を変更  r=要約して張り直す  m=今の記憶を表示  q=終了`;
log.info(HELP);
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const [cmd, ...rest] = line.trim().split(' ');
  const arg = rest.join(' ');
  switch (cmd) {
    case 'p': director.setPaused(!director.paused); break;
    case 's': speaker.stop(); break;
    case 't': if (arg) gemini.sendText(arg); break;
    case 'v': chat.start(arg); break;
    case 'r': gemini.rotate('手動'); break;
    case 'm': log.info(`現在の記憶 (${gemini.promptTokens} tokens)\n${memory.instruction().slice(config.gemini.persona.length)}`); break;
    case 'q': shutdown(); break;
    default: log.info(HELP);
  }
});

function shutdown() {
  log.info('終了します');
  mic.stop();
  gemini.close();
  setTimeout(() => process.exit(0), 300);
}
process.on('SIGINT', shutdown);
process.on('uncaughtException', (e) => log.error('uncaughtException', e));
process.on('unhandledRejection', (e) => log.error('unhandledRejection', e));
