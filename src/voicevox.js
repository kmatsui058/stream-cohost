// 音声合成: VOICEVOX ENGINE の HTTP API。audio_query で読み・抑揚を作り、synthesis で WAV にする。
import { logger } from './log.js';

const log = logger('voicevox');

export async function synthesize(text, { url, speaker, speedScale }) {
  const q = await fetch(`${url}/audio_query?speaker=${speaker}&text=${encodeURIComponent(text)}`, { method: 'POST' });
  if (!q.ok) throw new Error(`audio_query ${q.status}: ${await q.text()}`);
  const query = await q.json();
  query.speedScale = speedScale;
  const s = await fetch(`${url}/synthesis?speaker=${speaker}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(query),
  });
  if (!s.ok) throw new Error(`synthesis ${s.status}: ${await s.text()}`);
  return Buffer.from(await s.arrayBuffer());
}

export async function checkVoicevox(url) {
  try {
    const r = await fetch(`${url}/version`);
    log.info(`VOICEVOX ENGINE ${await r.text()} @ ${url}`);
    return true;
  } catch {
    log.error(`VOICEVOX に接続できません (${url})。VOICEVOX アプリを起動してください`);
    return false;
  }
}
