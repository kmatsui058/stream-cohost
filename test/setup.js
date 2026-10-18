// 全テスト共通: ログはテストごとの一時ディレクトリへ出し、コンソールには出さない。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach } from 'vitest';
import { configureLogging } from '../src/log.js';

beforeEach(() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cohost-log-'));
  configureLogging({ dir, debug: false, toConsole: false });
});
