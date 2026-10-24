import { describe, it, expect } from 'vitest';
import { loadConfig, missingRequired } from '../src/config.js';

const readPersona = (p) => `persona from ${p}`;

describe('operator-controls / 設定の既定値を使う', () => {
  it('何も指定しない: 文書化された既定値が使われる', () => {
    const c = loadConfig({}, readPersona);
    expect(c.gemini.persona).toBe('persona from persona.md');
    expect(c.listener).toEqual({
      model: 'gemini-3.5-transcribe-live',
      silenceDurationMs: 800,
      vocabulary: ['オルダ', 'ヴァール'],
    });
    expect(c.responder).toEqual({ model: 'gemini-4-argon', frames: 3, timeoutMs: 60000 });
    expect(c.summonWords).toEqual(['オルダ', 'ヴァール']);
    expect(c.memory).toEqual({ model: 'gemini-3.8-flash', maxChars: 4000, longMaxChars: 20000, recentEntries: 12, summarizeAtChars: 12000 });
    expect(c.lorebook).toEqual({ scanEntries: 6, stickyAsks: 3, maxChars: 3000 });
    expect(c.mic.ffmpeg).toBe('ffmpeg');
    expect(c.obs).toEqual({ url: 'ws://127.0.0.1:4455', password: undefined, frameIntervalMs: 2000, frameWidth: 960, sourceName: '' });
    expect(c.voicevox).toEqual({ url: 'http://127.0.0.1:50021', speaker: 47, speedScale: 1.15 });
    expect(c.overlay).toEqual({ port: 8787, displayName: 'ORÐA-VÁR', characterDir: '' });
    expect(c.director).toEqual({ bargeIn: 'duck', duckVolume: 0.3, duckReleaseMs: 1000, gateMicWhileSpeaking: false });
    expect(c.youtube.pollMinMs).toBe(10000);
  });

  it('割り込み時の動作: duck / stop / off。1・true は stop、0・false は off', () => {
    const mode = (v) => loadConfig({ BARGE_IN: v }, readPersona).director.bargeIn;
    expect([mode('duck'), mode('stop'), mode('off')]).toEqual(['duck', 'stop', 'off']);
    expect([mode('1'), mode('true'), mode('0'), mode('false')]).toEqual(['stop', 'stop', 'off', 'off']);
    const c = loadConfig({ DUCK_VOLUME: '0.5', DUCK_RELEASE_MS: '2000' }, readPersona).director;
    expect([c.duckVolume, c.duckReleaseMs]).toEqual([0.5, 2000]);
  });

  it('真偽値の指定: 0 は偽、1 と true は真として扱う', () => {
    expect(loadConfig({ GATE_MIC_WHILE_SPEAKING: '1' }, readPersona).director.gateMicWhileSpeaking).toBe(true);
    expect(loadConfig({ GATE_MIC_WHILE_SPEAKING: 'true' }, readPersona).director.gateMicWhileSpeaking).toBe(true);
  });

  it('数値と文字列の上書きが反映され、空文字は未指定として扱う', () => {
    const c = loadConfig({ VAD_SILENCE_MS: '1200', VOICEVOX_SPEAKER: '', PERSONA_FILE: 'x.md' }, readPersona);
    expect(c.listener.silenceDurationMs).toBe(1200);
    expect(c.voicevox.speaker).toBe(47);
    expect(c.gemini.persona).toBe('persona from x.md');
  });

  it('声と表示名の既定値: ナースロボ＿タイプＴ ノーマル（47）と ORÐA-VÁR', () => {
    const c = loadConfig({}, readPersona);
    expect(c.voicevox.speaker).toBe(47);
    expect(c.overlay.displayName).toBe('ORÐA-VÁR');
    expect(loadConfig({ COHOST_DISPLAY_NAME: 'ORDA' }, readPersona).overlay.displayName).toBe('ORDA');
    expect(loadConfig({ CHARACTER_DIR: 'C:\\chars' }, readPersona).overlay.characterDir).toBe('C:\\chars');
  });

  it('召喚の言葉を指定する: カンマ区切りで使われ、聞き取りやすくする語にも入る', () => {
    const c = loadConfig({ SUMMON_WORDS: 'オルダ, ヴァール ,オルダちゃん', CUSTOM_VOCABULARY: 'ニブルヘイム,ソーサラー' }, readPersona);
    expect(c.summonWords).toEqual(['オルダ', 'ヴァール', 'オルダちゃん']);
    expect(c.listener.vocabulary).toEqual(['オルダ', 'ヴァール', 'オルダちゃん', 'ニブルヘイム', 'ソーサラー']);
  });
});

describe('operator-controls / 必須設定の確認', () => {
  it('API キーとマイクのデバイス名が欠けていれば、その名前を返す', () => {
    expect(missingRequired(loadConfig({}, readPersona))).toEqual(['GEMINI_API_KEY', 'MIC_DEVICE']);
    expect(missingRequired(loadConfig({ GEMINI_API_KEY: 'k', MIC_DEVICE: 'm' }, readPersona))).toEqual([]);
  });
});
