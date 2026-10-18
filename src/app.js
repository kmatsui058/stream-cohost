// 組み立て: 各部品を生成して配線し、コンソール操作を処理する。
// 外部依存（AI クライアント、子プロセス、OBS クライアント、fetch、音声合成）は deps で差し替えられる。
import { GoogleGenAI } from '@google/genai';
import { logger } from './log.js';
import { Mic } from './mic.js';
import { ObsCapture } from './obs.js';
import { GeminiLive } from './gemini.js';
import { Memory } from './memory.js';
import { Overlay } from './overlay.js';
import { Speaker } from './speaker.js';
import { Director } from './director.js';
import { YouTubeChat } from './youtube.js';
import { checkVoicevox, synthesize } from './voicevox.js';

const log = logger('main');
const ROTATE_CHECK_MS = 2000;

export const HELP =
  '操作: p=一時停止/再開  s=今の発話をスキップ  t <文>=テキストで話しかける  v <動画ID>=チャット対象を変更  r=要約して張り直す  m=今の記憶を表示  q=終了';

export function createApp(config, deps = {}) {
  const fetchFn = deps.fetch ?? fetch;
  const ai = deps.ai ?? new GoogleGenAI({ apiKey: config.gemini.apiKey });
  const onQuit = deps.onQuit ?? (() => {});
  const carryOver = deps.carryOver ?? true; // 前回の記憶を引き継ぐか（npm run start:fresh で false）

  const overlay = new Overlay(config.overlay);
  const gemini = new GeminiLive(config.gemini, ai);
  const memory = new Memory({
    ai, persona: config.gemini.persona, ...config.memory,
    ...(deps.summaryFile && { summaryFile: deps.summaryFile }),
    ...(deps.stateFile && { stateFile: deps.stateFile }),
  });
  gemini.memory = memory;
  const speaker = new Speaker(overlay, config.voicevox, {
    synthesize: deps.synthesize ?? ((text, cfg) => synthesize(text, cfg, fetchFn)),
  });
  const director = new Director({ gemini, speaker, memory, cfg: config.director, isAudible: () => overlay.hasClient });
  overlay.on('connect', () => director.markActivity());
  const mic = new Mic(config.mic, deps.spawn ? { spawn: deps.spawn } : {});
  const obs = new ObsCapture(config.obs, deps.obsClient ? { client: deps.obsClient } : {});
  const chat = new YouTubeChat(config.youtube, { fetch: fetchFn });

  mic.on('chunk', (pcm) => {
    if (director.paused) return;
    if (config.director.gateMicWhileSpeaking && speaker.speaking) return;
    gemini.sendAudio(pcm);
  });
  obs.on('frame', (jpeg) => {
    if (!director.paused) gemini.sendFrame(jpeg);
  });
  chat.on('messages', (msgs) => director.addChat(msgs));
  // 配信のタイトルと概要欄をコンテキストに載せる。セッション中に変わったら張り直して反映する
  chat.on('info', (info) => {
    if (memory.setStreamInfo(info) && gemini.ready) gemini.rotate('配信の情報を反映');
  });

  // コンテキストが大きくなったら、場が空いたタイミングで要約して張り直す
  function checkRotate() {
    const limit = config.memory.rotateAtTokens;
    if (limit && gemini.ready && gemini.promptTokens > limit && director.quiet && Date.now() > gemini.nextRotateAt) {
      gemini.rotate(`コンテキスト ${gemini.promptTokens} > ${limit}`);
    }
  }
  let rotateTimer = null;

  async function start() {
    await checkVoicevox(config.voicevox.url, fetchFn);
    const port = await overlay.start();
    if (carryOver) memory.loadPrevious();
    else log.info('前回の記憶は引き継がずに起動します');
    await gemini.connect();
    mic.start();
    obs.start();
    chat.start(config.youtube.videoId);
    rotateTimer = setInterval(checkRotate, ROTATE_CHECK_MS);
    log.info(HELP);
    return port;
  }

  let stopped = false;
  async function shutdown() {
    if (stopped) return;
    stopped = true;
    log.info('終了します');
    clearInterval(rotateTimer);
    mic.stop();
    obs.stop();
    chat.stop();
    director.dispose();
    await memory.finalize(); // 要約して保存してから閉じる（要約に AI を使うので先に）
    gemini.close();
    await overlay.close();
  }

  function handleCommand(line) {
    const [cmd, ...rest] = line.trim().split(' ');
    const arg = rest.join(' ').trim();
    switch (cmd) {
      case 'p': director.setPaused(!director.paused); break;
      case 's': speaker.stop(); break;
      case 't': if (arg) gemini.sendText(arg); break;
      case 'v': chat.start(arg); break;
      case 'r': gemini.rotate('手動'); break;
      case 'm': log.info(`現在の記憶 (${gemini.promptTokens} tokens)\n${memory.instruction().slice(config.gemini.persona.length) || '（まだなし）'}`); break;
      case 'q': return shutdown().then(onQuit);
      default: log.info(HELP);
    }
  }

  return { overlay, gemini, memory, speaker, director, mic, obs, chat, start, shutdown, handleCommand, checkRotate };
}
