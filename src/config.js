// 設定はすべて環境変数（.env）から読む。既定値はここに集約。
import fs from 'node:fs';

export function loadConfig(env = process.env, readFile = (p) => fs.readFileSync(p, 'utf8')) {
  const num = (k, d) => (env[k] !== undefined && env[k] !== '' ? Number(env[k]) : d);
  const bool = (k, d) => (env[k] !== undefined && env[k] !== '' ? env[k] === '1' || env[k] === 'true' : d);

  return {
    gemini: {
      apiKey: env.GEMINI_API_KEY,
      model: env.GEMINI_MODEL || 'gemini-3.8-live',
      persona: readFile(env.PERSONA_FILE || 'persona.md'),
      // Gemini 側の発話区切り判定（ms）。短いと話の途中で返答し始める
      silenceDurationMs: num('VAD_SILENCE_MS', 800),
      // 1 接続内のコンテキスト上限（超えたら target まで古い順に捨てられる）
      triggerTokens: num('CONTEXT_TRIGGER_TOKENS', 32000),
      targetTokens: num('CONTEXT_TARGET_TOKENS', 16000),
    },
    memory: {
      model: env.SUMMARY_MODEL || 'gemini-3.5-flash-lite',
      maxChars: num('SUMMARY_MAX_CHARS', 1500),
      // 要約せずにそのまま残す直近の発言数（配信者・相方・チャットそれぞれ 1 件）
      recentEntries: num('RECENT_ENTRIES', 12),
      // コンテキストがこのトークン数を超えたら、場が空いたタイミングで要約して張り直す。0 で無効
      rotateAtTokens: num('ROTATE_AT_TOKENS', 24000),
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
      speaker: num('VOICEVOX_SPEAKER', 47), // 47 = ナースロボ＿タイプＴ ノーマル
      speedScale: num('VOICEVOX_SPEED', 1.15),
    },
    overlay: {
      port: num('OVERLAY_PORT', 8787),
      // 画面左下の SOUND ONLY 表示に出す相方の名前
      displayName: env.COHOST_DISPLAY_NAME || 'ORÐA-VÁR',
    },
    director: {
      // 無音がこの秒数（min〜max でランダム）続いたら自発的に喋らせる。0 で無効
      idleMinSec: num('IDLE_MIN_SEC', 25),
      idleMaxSec: num('IDLE_MAX_SEC', 45),
      // 自分の声が届いたら相方の発話を止める（バージイン）
      bargeIn: bool('BARGE_IN', true),
      // 相方が喋っている間マイクを Gemini に送らない（スピーカー運用で相方の声を拾う場合に 1）
      gateMicWhileSpeaking: bool('GATE_MIC_WHILE_SPEAKING', false),
    },
    youtube: {
      apiKey: env.YOUTUBE_API_KEY,
      videoId: env.YOUTUBE_VIDEO_ID,
      pollMinMs: num('CHAT_POLL_MIN_MS', 10000),
    },
  };
}

// 起動に必須の設定のうち、欠けているものの環境変数名を返す
export function missingRequired(config) {
  const missing = [];
  if (!config.gemini.apiKey) missing.push('GEMINI_API_KEY');
  if (!config.mic.device) missing.push('MIC_DEVICE');
  return missing;
}
