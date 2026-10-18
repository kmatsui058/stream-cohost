import fs from 'node:fs';
import { describe, it, expect, vi } from 'vitest';
import { synthesize, checkVoicevox } from '../src/voicevox.js';
import { logFilePath } from '../src/log.js';

const vv = { url: 'http://127.0.0.1:50021', speaker: 3, speedScale: 1.15 };
const res = (body, { ok = true, status = 200 } = {}) => ({
  ok,
  status,
  json: async () => body,
  text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  arrayBuffer: async () => new Uint8Array([82, 73, 70, 70]).buffer,
});

describe('speech-output', () => {
  describe('文を音声合成する', () => {
    it('audio_query → synthesis の順に、話者と話速を指定して WAV を得る', async () => {
      const fetchFn = vi.fn()
        .mockResolvedValueOnce(res({ accent_phrases: [], speedScale: 1 }))
        .mockResolvedValueOnce(res(null));
      const wav = await synthesize('こんにちは。', vv, fetchFn);
      expect(fetchFn.mock.calls[0][0]).toBe(`${vv.url}/audio_query?speaker=3&text=${encodeURIComponent('こんにちは。')}`);
      expect(fetchFn.mock.calls[0][1]).toEqual({ method: 'POST' });
      expect(fetchFn.mock.calls[1][0]).toBe(`${vv.url}/synthesis?speaker=3`);
      expect(JSON.parse(fetchFn.mock.calls[1][1].body)).toEqual({ accent_phrases: [], speedScale: 1.15 });
      expect(wav.toString('ascii')).toBe('RIFF');
    });

    it('エンジンがエラーを返したら、ステータスと本文つきで失敗する', async () => {
      const fetchFn = vi.fn().mockResolvedValueOnce(res('bad speaker', { ok: false, status: 422 }));
      await expect(synthesize('あ', vv, fetchFn)).rejects.toThrow('audio_query 422: bad speaker');
      const fetch2 = vi.fn().mockResolvedValueOnce(res({})).mockResolvedValueOnce(res('oops', { ok: false, status: 500 }));
      await expect(synthesize('あ', vv, fetch2)).rejects.toThrow('synthesis 500: oops');
    });
  });

  describe('音声合成エンジンの確認', () => {
    it('起動している: true を返し、バージョンを記録する', async () => {
      expect(await checkVoicevox(vv.url, vi.fn().mockResolvedValue(res('"0.25.2"')))).toBe(true);
    });

    it('エンジンが起動していない: 起動を促すエラーを記録して false を返す', async () => {
      const ok = await checkVoicevox(vv.url, vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));
      expect(ok).toBe(false);
      await new Promise((r) => setTimeout(r, 50));
      expect(fs.readFileSync(logFilePath(), 'utf8')).toMatch(/ERROR .*VOICEVOX アプリを起動してください/);
    });
  });
});
