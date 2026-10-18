// 設定はすべて .env から読む（node --env-file=.env で起動）。既定値はここに集約。
import fs from 'node:fs';

const env = process.env;
const num = (k, d) => (env[k] !== undefined && env[k] !== '' ? Number(env[k]) : d);
const bool = (k, d) => (env[k] !== undefined && env[k] !== '' ? env[k] === '1' || env[k] === 'true' : d);

export const config = {
  gemini: {
    apiKey: env.GEMINI_API_KEY,
    model: env.GEMINI_MODEL || 'gemini-3.8-live',
    persona: fs.readFileSync(env.PERSONA_FILE || 'persona.md', 'utf8'),
    // Gemini 側の発話区切り判定（ms）。短いと話の途中で返答し始める
    silenceDurationMs: num('VAD_SILENCE_MS', 800),
  },
  mic: {
    // ffmpeg の dshow デバイス名。`npm run mics` で一覧が出る
    device: env.MIC_DEVICE,
    ffmpeg: env.FFMPEG_PATH || 'ffmpeg',
  },
  obs: {
    url: env.OBS_WS_URL || 'ws://127.0.0.1:4455',
    password: env.OBS_WS_PASSWORD || undefined,
    // 画面キャプチャ間隔。Live API の上限は 1fps
    frameIntervalMs: num('FRAME_INTERVAL_MS', 2000),
    frameWidth: num('FRAME_WIDTH', 960),
    // 空なら「現在のプログラムシーン」= 配信に出ている画面
    sourceName: env.OBS_CAPTURE_SOURCE || '',
  },
  voicevox: {
    url: env.VOICEVOX_URL || 'http://127.0.0.1:50021',
    speaker: num('VOICEVOX_SPEAKER', 3), // 3 = ずんだもん ノーマル
    speedScale: num('VOICEVOX_SPEED', 1.15),
  },
  overlay: {
    port: num('OVERLAY_PORT', 8787),
  },
  director: {
    // 無音がこの秒数（min〜max でランダム）続いたら自発的に喋らせる。0 で無効
    idleMinSec: num('IDLE_MIN_SEC', 25),
    idleMaxSec: num('IDLE_MAX_SEC', 45),
    // 自分の声が届いたら相方の発話を止める（バージイン）
    bargeIn: bool('BARGE_IN', true),
    // 相方が喋っている間マイクを Gemini に送らない（スピーカー運用でハウる場合に 1）
    gateMicWhileSpeaking: bool('GATE_MIC_WHILE_SPEAKING', false),
  },
  youtube: {
    apiKey: env.YOUTUBE_API_KEY,
    videoId: env.YOUTUBE_VIDEO_ID,
  },
};
