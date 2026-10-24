// コンソールと <dir>/YYYY-MM-DD.log の両方に出す。トラブル時はログファイルを見る。
// 既定の出力先は ./logs。1 行ずつ同期で追記する（書いた直後に読める。実行中もファイルを開いたままにしない）。
import fs from 'node:fs';
import path from 'node:path';

const settings = {
  dir: path.resolve('logs'),
  debug: process.env.LOG_DEBUG === '1',
  toConsole: true,
};
let dirReady = false;

export function configureLogging(opts) {
  Object.assign(settings, opts);
  dirReady = false;
}

export function logFilePath() {
  return path.join(settings.dir, `${new Date().toISOString().slice(0, 10)}.log`);
}

function write(level, tag, args) {
  const ts = new Date().toLocaleTimeString('ja-JP', { hour12: false });
  const msg = args.map((a) => (a instanceof Error ? a.stack : typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
  const line = `${ts} ${level.padEnd(5)} [${tag}] ${msg}`;
  if (!dirReady) {
    fs.mkdirSync(settings.dir, { recursive: true });
    dirReady = true;
  }
  fs.appendFileSync(logFilePath(), line + '\n');
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
