import { describe, it, expect } from 'vitest';
import { loadConfig, missingRequired } from '../src/config.js';

const readPersona = (p) => `persona from ${p}`;

describe('operator-controls / 設定の既定値', () => {
  it('何も指定しない: 文書化された既定値が使われる', () => {
    const c = loadConfig({}, readPersona);
    expect(c.gemini.model).toBe('gemini-3.8-live');
    expect(c.gemini.persona).toBe('persona from persona.md');
    expect(c.gemini.silenceDurationMs).toBe(800);
    expect(c.gemini.triggerTokens).toBe(32000);
    expect(c.gemini.targetTokens).toBe(16000);
    expect(c.memory).toEqual({ model: 'gemini-3.5-flash-lite', maxChars: 1500, recentEntries: 12, rotateAtTokens: 24000 });
    expect(c.mic.ffmpeg).toBe('ffmpeg');
    expect(c.obs).toEqual({ url: 'ws://127.0.0.1:4455', password: undefined, frameIntervalMs: 2000, frameWidth: 960, sourceName: '' });
    expect(c.voicevox).toEqual({ url: 'http://127.0.0.1:50021', speaker: 47, speedScale: 1.15 });
    expect(c.overlay).toEqual({ port: 8787, displayName: 'ORÐA-VÁR' });
    expect(c.director).toEqual({ idleMinSec: 25, idleMaxSec: 45, bargeIn: true, gateMicWhileSpeaking: false });
    expect(c.youtube.pollMinMs).toBe(10000);
  });

  it('真偽値の指定: 0 は偽、1 と true は真として扱う', () => {
    expect(loadConfig({ BARGE_IN: '0' }, readPersona).director.bargeIn).toBe(false);
    expect(loadConfig({ GATE_MIC_WHILE_SPEAKING: '1' }, readPersona).director.gateMicWhileSpeaking).toBe(true);
    expect(loadConfig({ GATE_MIC_WHILE_SPEAKING: 'true' }, readPersona).director.gateMicWhileSpeaking).toBe(true);
  });

  it('数値と文字列の上書きが反映され、空文字は未指定として扱う', () => {
    const c = loadConfig({ IDLE_MIN_SEC: '0', VOICEVOX_SPEAKER: '', PERSONA_FILE: 'x.md' }, readPersona);
    expect(c.director.idleMinSec).toBe(0);
    expect(c.voicevox.speaker).toBe(47);
    expect(c.gemini.persona).toBe('persona from x.md');
  });
});

describe('operator-controls / 設定の既定値（声と表示名）', () => {
  it('声と表示名の既定値: ナースロボ＿タイプＴ ノーマル（47）と ORÐA-VÁR', () => {
    const c = loadConfig({}, readPersona);
    expect(c.voicevox.speaker).toBe(47);
    expect(c.overlay.displayName).toBe('ORÐA-VÁR');
    expect(loadConfig({ COHOST_DISPLAY_NAME: 'ORDA' }, readPersona).overlay.displayName).toBe('ORDA');
  });
});

describe('operator-controls / 必須設定の確認', () => {
  it('API キーとマイクのデバイス名が欠けていれば、その名前を返す', () => {
    expect(missingRequired(loadConfig({}, readPersona))).toEqual(['GEMINI_API_KEY', 'MIC_DEVICE']);
    expect(missingRequired(loadConfig({ GEMINI_API_KEY: 'k', MIC_DEVICE: 'm' }, readPersona))).toEqual([]);
  });
});
