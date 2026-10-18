// エントリポイント: 設定を読み、必須設定を確認して、アプリを起動する。標準入力とシグナルをつなぐだけ。
import readline from 'node:readline';
import { loadConfig, missingRequired } from './config.js';
import { logger } from './log.js';
import { createApp } from './app.js';

const log = logger('main');

const config = loadConfig();
const missing = missingRequired(config);
if (missing.length) {
  log.error(`必須の設定が .env にありません: ${missing.join(', ')}`);
  process.exit(1);
}

const exit = () => setTimeout(() => process.exit(0), 300);
// --fresh: 前回の記憶を引き継がずに起動する（テスト用。npm run start:fresh）
const app = createApp(config, { onQuit: exit, carryOver: !process.argv.includes('--fresh') });
await app.start();

readline.createInterface({ input: process.stdin }).on('line', (line) => app.handleCommand(line));
process.on('SIGINT', () => app.shutdown().then(exit));
process.on('uncaughtException', (e) => log.error('uncaughtException', e));
process.on('unhandledRejection', (e) => log.error('unhandledRejection', e));
