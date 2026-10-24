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
      // 1 回の問い合わせの待ち時間。時間切れやエラーなら 1 回だけやり直す
      timeoutMs: num('RESPONDER_TIMEOUT_MS', 30000),
      // Google 検索を使わせるか（最新の情報や、確かでない仕様を確かめる。検索すると数秒遅くなる）
      search: bool('RESPONDER_SEARCH', true),
    },
    memory: {
      model: env.SUMMARY_MODEL || 'gemini-3.8-flash',
      maxChars: num('SUMMARY_MAX_CHARS', 4000),
      // 配信をまたいで積み上げる要約の上限。答える役への問い合わせのたびに送るので、長いほど費用が増える
      longMaxChars: num('LONG_SUMMARY_MAX_CHARS', 20000),
      // 要約せずにそのまま残す直近の発言数
      recentEntries: num('RECENT_ENTRIES', 12),
      // 要約していない記録がこの文字数を超えたら要約する
      summarizeAtChars: num('SUMMARIZE_AT_CHARS', 12000),
      // 要約がこの時間（ms）で返らなければ失敗とし、次の機会にやり直す（控えも一緒に返すので長めに）
      timeoutMs: num('SUMMARY_TIMEOUT_MS', 120000),
    },
    // 控え（ロアブック）: 直近の記録の何件からキーワードを探すか、当たった後に何回入れたままにするか、1 回に入れる上限の文字数
    lorebook: {
      scanEntries: num('LORE_SCAN_ENTRIES', 6),
      stickyAsks: num('LORE_STICKY_ASKS', 3),
      maxChars: num('LORE_MAX_CHARS', 3000),
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
      // 召喚直後（最初に喋るまで）の相方の不透明度。1 なら最初からはっきり表示する
      summonOpacity: num('SUMMON_OPACITY', 1),
    },
    director: {
      // 相方が喋っている間に配信者が話したとき: duck = 声を小さくする / stop = 中断する / off = 何もしない
      bargeIn: bargeInMode(env.BARGE_IN),
      // duck のときの音量（0〜1）と、途中経過が途切れてから元に戻すまでの時間（ms）
      duckVolume: num('DUCK_VOLUME', 0.3),
      duckReleaseMs: num('DUCK_RELEASE_MS', 1000),
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

// 割り込み時の動作。以前の真偽値の指定（1/true = 中断、0/false = 何もしない）も受け付ける
function bargeInMode(v) {
  if (v === '1' || v === 'true' || v === 'stop') return 'stop';
  if (v === '0' || v === 'false' || v === 'off') return 'off';
  return 'duck';
}

// 起動に必須の設定のうち、欠けているものの環境変数名を返す
export function missingRequired(config) {
  const missing = [];
  if (!config.gemini.apiKey) missing.push('GEMINI_API_KEY');
  if (!config.mic.device) missing.push('MIC_DEVICE');
  return missing;
}
