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
import { Lorebook } from './lorebook.js';
import { Overlay } from './overlay.js';
import { Speaker } from './speaker.js';
import { Director } from './director.js';
import { YouTubeChat } from './youtube.js';
import { checkVoicevox, synthesize } from './voicevox.js';

const log = logger('main');

export const HELP =
  '操作: p=一時停止/再開  s=今の発話をスキップ  t <文>=テキストで話しかける  o=召喚/退去  k <キーワード,…> = <内容>=控えを足す  kl=控えの一覧  kd <番号>=控えを消す  v <動画ID>=チャット対象を変更  r=今すぐ要約  m=今の記憶を表示  q=終了';

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
  const lorebook = new Lorebook({ ...config.lorebook, ...(deps.lorebookFile && { file: deps.lorebookFile }) });
  memory.lorebook = lorebook;
  const speaker = new Speaker(overlay, config.voicevox, {
    synthesize: deps.synthesize ?? ((text, cfg) => synthesize(text, cfg, fetchFn)),
  });
  const frames = []; // 直近の配信画面（古い順）
  const director = new Director({
    responder, speaker, memory,
    cfg: config.director,
    summonWords: config.summonWords,
    getFrames: () => [...frames],
    lorebook,
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
  director.on('thinking', (on, summon) => overlay.setThinking(on, summon));
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
    lorebook.load();
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
  let quit = false;
  async function shutdown() {
    if (stopped) return;
    stopped = true;
    log.info('終了します');
    mic.stop();
    obs.stop();
    chat.stop();
    listener.close(); // 記憶を保存している間に再接続しないよう、先に閉じる
    log.info(`記憶を保存しています（最大 ${(memory.timeoutMs * 2) / 1000} 秒）。待たずに終わるなら、もう一度 q`);
    await memory.finalize(); // 今回分を要約し、これまでの配信の要約とまとめ直して保存する
    await overlay.close();
  }

  // 1 回目の q で記憶を保存してから終わる。保存中の 2 回目の q で、その時点の記憶を保存してすぐ終わる
  function quitCommand() {
    if (quit) return;
    if (!stopped) return shutdown().then(() => { if (!quit) { quit = true; onQuit(); } });
    quit = true;
    log.info('記憶の保存を打ち切って終了します（その時点の内容を保存）');
    memory.save();
    onQuit();
  }

  // k キーワード,キーワード = 内容
  function addLore(arg) {
    const i = arg.indexOf('=');
    const keys = i < 0 ? [] : arg.slice(0, i).split(/[、,，]/);
    if (i < 0 || !lorebook.add({ keys, content: arg.slice(i + 1) })) log.warn('書き方: k キーワード,キーワード = 内容');
  }

  function handleCommand(line) {
    // 全角の英数字・空白でも受け付ける
    const [cmd, ...rest] = line.normalize('NFKC').trim().split(' ');
    const arg = rest.join(' ').trim();
    switch (cmd) {
      case 'p': director.setPaused(!director.paused); break;
      case 's': speaker.stop(); break;
      case 't': if (arg) director.onUtterance(arg); break;
      case 'o': director.toggleSummon(); break;
      case 'k': addLore(arg); break;
      case 'kl': log.info(`控え\n${lorebook.list() || '（なし）'}`); break;
      case 'kd': if (!lorebook.removeAt(Number(arg))) log.warn(`控えの番号が見つかりません: ${arg}`); break;
      case 'v': chat.start(arg); break;
      case 'r': memory.summarize().catch((e) => log.warn(`要約に失敗しました: ${e.message}`)); break;
      case 'm': log.info(`現在の記憶\n${memory.instruction().slice(config.gemini.persona.length).trim() || '（要約なし）'}\n\n# 要約以降の記録\n${memory.transcript() || '（なし）'}`); break;
      case 'q': return quitCommand();
      default: log.info(HELP);
    }
  }

  return { overlay, listener, responder, memory, lorebook, speaker, director, mic, obs, chat, frames, start, shutdown, handleCommand };
}
