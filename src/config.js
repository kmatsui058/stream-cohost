// 設定はすべて環境変数（.env）から読む。既定値はここに集約。
import fs from 'node:fs';

export function loadConfig(env = process.env, readFile = (p) => fs.readFileSync(p, 'utf8')) {
  const num = (k, d) => (env[k] !== undefined && env[k] !== '' ? Number(env[k]) : d);
  const list = (k, d) => (env[k] ? env[k].split(',').map((s) => s.trim()).filter(Boolean) : d);
  const bool = (k, d) => (env[k] !== undefined && env[k] !== '' ? env[k] === '1' || env[k] === 'true' : d);

  const summonWords = list('SUMMON_WORDS', ['オルダ', 'ヴァール']);
  return {
    gemini: {
      apiKey: env.GEMINI_API_KEY,
      persona: readFile(env.PERSONA_FILE || 'persona.md'),
    },
    // 呼ばれたら相方が現れる言葉（文字起こしに含まれたら召喚する）
    summonWords,
    // 聞く役: マイク音声を文字起こしするだけの Live セッション
    listener: {
      model: env.LISTENER_MODEL || 'gemini-3.5-transcribe-live',
      // 無音がこの長さ（ms）続いたら 1 発話として区切る
      silenceDurationMs: num('VAD_SILENCE_MS', 800),
      // 聞き取りやすくする語（召喚の言葉 + 用語）
      vocabulary: [...summonWords, ...list('CUSTOM_VOCABULARY', [])],
    },
    // 答える役: 召喚中の発話に、考えてから答えるモデル
    responder: {
      model: env.RESPONDER_MODEL || 'gemini-4-argon',
      // 問い合わせに添える直近の画面の枚数
      frames: num('RESPONDER_FRAMES', 3),
      timeoutMs: num('RESPONDER_TIMEOUT_MS', 60000),
    },
    memory: {
      model: env.SUMMARY_MODEL || 'gemini-3.8-flash',
      maxChars: num('SUMMARY_MAX_CHARS', 4000),
      // 要約せずにそのまま残す直近の発言数
      recentEntries: num('RECENT_ENTRIES', 12),
      // 要約していない記録がこの文字数を超えたら要約する
      summarizeAtChars: num('SUMMARIZE_AT_CHARS', 12000),
    },
    mic: {
      // ffmpeg の dshow デバイス名。`npm run mics` で一覧が出る
      device: env.MIC_DEVICE,
      ffmpeg: env.FFMPEG_PATH || 'ffmpeg',
    },
    obs: {
      url: env.OBS_WS_URL || 'ws://127.0.0.1:4455',
      password: env.OBS_WS_PASSWORD || undefined,
      // 画面キャプチャの間隔。直近の数枚を問い合わせに添える
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
      // 立ち絵フォルダ（default.png と smile.png）。空なら SOUND ONLY 表示
      characterDir: env.CHARACTER_DIR || '',
    },
    director: {
      // 自分の声が届いたら相方の発話を止める（バージイン）
      bargeIn: bool('BARGE_IN', true),
      // 相方が喋っている間マイクを聞く役に送らない（スピーカー運用で相方の声を拾う場合に 1）
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
