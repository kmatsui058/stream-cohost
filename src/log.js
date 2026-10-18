// コンソールと <dir>/YYYY-MM-DD.log の両方に出す。トラブル時はログファイルを見る。
// 既定の出力先は ./logs。ファイルは最初に書き込むときに開く。
import fs from 'node:fs';
import path from 'node:path';

const settings = {
  dir: path.resolve('logs'),
  debug: process.env.LOG_DEBUG === '1',
  toConsole: true,
};
let stream = null;

export function configureLogging(opts) {
  Object.assign(settings, opts);
  stream?.end();
  stream = null;
}

export function logFilePath() {
  return path.join(settings.dir, `${new Date().toISOString().slice(0, 10)}.log`);
}

function write(level, tag, args) {
  const ts = new Date().toLocaleTimeString('ja-JP', { hour12: false });
  const msg = args.map((a) => (a instanceof Error ? a.stack : typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
  const line = `${ts} ${level.padEnd(5)} [${tag}] ${msg}`;
  if (!stream) {
    fs.mkdirSync(settings.dir, { recursive: true });
    stream = fs.createWriteStream(logFilePath(), { flags: 'a' });
  }
  stream.write(line + '\n');
  if (settings.toConsole && (level !== 'DEBUG' || settings.debug)) console.log(line);
}

export function logger(tag) {
  return {
    debug: (...a) => write('DEBUG', tag, a),
    info: (...a) => write('INFO', tag, a),
    warn: (...a) => write('WARN', tag, a),
    error: (...a) => write('ERROR', tag, a),
  };
}
