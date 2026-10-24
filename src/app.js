// 組み立て: 各部品を生成して配線し、コンソール操作を処理する。
// 外部依存（AI クライアント、子プロセス、OBS クライアント、fetch、音声合成）は deps で差し替えられる。
//
//   マイク → listener（文字起こし）→ director ─┬→ responder（召喚中だけ問い合わせ）→ speaker → overlay
//   チャット ────────────────────────────┘
//   OBS の画面 → 直近の数枚を持っておき、問い合わせに添える
import { GoogleGenAI } from '@google/genai';
import { logger } from './log.js';
import { Mic } from './mic.js';
import { ObsCapture } from './obs.js';
import { Listener } from './listener.js';
import { Responder } from './responder.js';
import { Memory } from './memory.js';
import { Overlay } from './overlay.js';
import { Speaker } from './speaker.js';
import { Director } from './director.js';
import { YouTubeChat } from './youtube.js';
import { checkVoicevox, synthesize } from './voicevox.js';

const log = logger('main');

export const HELP =
  '操作: p=一時停止/再開  s=今の発話をスキップ  t <文>=テキストで話しかける  o=召喚/退去  v <動画ID>=チャット対象を変更  r=今すぐ要約  m=今の記憶を表示  q=終了';

export function createApp(config, deps = {}) {
  const fetchFn = deps.fetch ?? fetch;
  const ai = deps.ai ?? new GoogleGenAI({ apiKey: config.gemini.apiKey });
  const onQuit = deps.onQuit ?? (() => {});
  const carryOver = deps.carryOver ?? true; // 前回の記憶を引き継ぐか（npm run start:fresh で false）

  const overlay = new Overlay(config.overlay);
  const listener = new Listener(config.listener, ai);
  const responder = new Responder(config.responder, ai);
  const memory = new Memory({
    ai, persona: config.gemini.persona, ...config.memory,
    ...(deps.stateFile && { stateFile: deps.stateFile }),
  });
  const speaker = new Speaker(overlay, config.voicevox, {
    synthesize: deps.synthesize ?? ((text, cfg) => synthesize(text, cfg, fetchFn)),
  });
  const frames = []; // 直近の配信画面（古い順）
  const director = new Director({
    responder, speaker, memory,
    cfg: config.director,
    summonWords: config.summonWords,
    getFrames: () => [...frames],
  });
  const mic = new Mic(config.mic, deps.spawn ? { spawn: deps.spawn } : {});
  const obs = new ObsCapture(config.obs, deps.obsClient ? { client: deps.obsClient } : {});
  const chat = new YouTubeChat(config.youtube, { fetch: fetchFn });

  mic.on('chunk', (pcm) => {
    if (director.paused) return;
    if (config.director.gateMicWhileSpeaking && speaker.speaking) return;
    listener.sendAudio(pcm);
  });
  listener.on('utterance', (text) => director.onUtterance(text));
  listener.on('interim', (text) => director.onInterim(text));
  director.on('presence', (visible) => overlay.setPresence(visible));
  obs.on('frame', (jpeg) => {
    frames.push(jpeg);
    if (frames.length > config.responder.frames) frames.shift();
  });
  chat.on('messages', (msgs) => director.addChat(msgs));
  // OBS で選んだ配信枠に、チャットの対象と配信情報を合わせる（最後に起きた指定が勝つ）
  obs.on('broadcast', (id) => chat.start(id));
  // 配信のタイトルと概要欄は、次の問い合わせから指示に入る
  chat.on('info', (info) => memory.setStreamInfo(info));

  async function start() {
    await checkVoicevox(config.voicevox.url, fetchFn);
    const port = await overlay.start();
    if (carryOver) memory.loadPrevious();
    else log.info('前回の記憶は引き継がずに起動します');
    await listener.connect();
    mic.start();
    obs.start();
    chat.start(config.youtube.videoId);
    log.info(HELP);
    return port;
  }

  let stopped = false;
  async function shutdown() {
    if (stopped) return;
    stopped = true;
    log.info('終了します');
    mic.stop();
    obs.stop();
    chat.stop();
    await memory.finalize(); // 要約して保存してから閉じる
    listener.close();
    await overlay.close();
  }

  function handleCommand(line) {
    const [cmd, ...rest] = line.trim().split(' ');
    const arg = rest.join(' ').trim();
    switch (cmd) {
      case 'p': director.setPaused(!director.paused); break;
      case 's': speaker.stop(); break;
      case 't': if (arg) director.onUtterance(arg); break;
      case 'o': director.toggleSummon(); break;
      case 'v': chat.start(arg); break;
      case 'r': memory.summarize().catch((e) => log.warn(`要約に失敗しました: ${e.message}`)); break;
      case 'm': log.info(`現在の記憶\n${memory.instruction().slice(config.gemini.persona.length).trim() || '（要約なし）'}\n\n# 要約以降の記録\n${memory.transcript() || '（なし）'}`); break;
      case 'q': return shutdown().then(onQuit);
      default: log.info(HELP);
    }
  }

  return { overlay, listener, responder, memory, speaker, director, mic, obs, chat, frames, start, shutdown, handleCommand };
}
