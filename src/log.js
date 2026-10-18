// コンソールと logs/YYYY-MM-DD.log の両方に出す。トラブル時はログファイルを見る。
import fs from 'node:fs';
import path from 'node:path';

const dir = path.resolve('logs');
fs.mkdirSync(dir, { recursive: true });
const file = path.join(dir, `${new Date().toISOString().slice(0, 10)}.log`);
const stream = fs.createWriteStream(file, { flags: 'a' });

const DEBUG = process.env.LOG_DEBUG === '1';

function write(level, tag, args) {
  const ts = new Date().toLocaleTimeString('ja-JP', { hour12: false });
  const msg = args.map((a) => (a instanceof Error ? a.stack : typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
  const line = `${ts} ${level.padEnd(5)} [${tag}] ${msg}`;
  stream.write(line + '\n');
  if (level !== 'DEBUG' || DEBUG) console.log(line);
}

export function logger(tag) {
  return {
    debug: (...a) => write('DEBUG', tag, a),
    info: (...a) => write('INFO', tag, a),
    warn: (...a) => write('WARN', tag, a),
    error: (...a) => write('ERROR', tag, a),
  };
}
