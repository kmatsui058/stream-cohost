import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, vi } from 'vitest';
import { configureLogging, logger, logFilePath } from '../src/log.js';

const flush = () => new Promise((r) => setTimeout(r, 50));

describe('operator-controls / ログを残す', () => {
  it('詳細ログが無効: コンソールには出ず、ログファイルには記録される', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cohost-logtest-'));
    configureLogging({ dir, debug: false, toConsole: true });
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const log = logger('test');
    log.debug('細かい情報');
    log.info('普通の情報');
    await flush();
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][0]).toMatch(/INFO +\[test\] 普通の情報/);
    const text = fs.readFileSync(logFilePath(), 'utf8');
    expect(text).toMatch(/DEBUG \[test\] 細かい情報/);
    expect(text).toMatch(/INFO +\[test\] 普通の情報/);
  });

  it('詳細ログが有効ならコンソールにも出し、Error はスタックを、オブジェクトは JSON を書く', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cohost-logtest-'));
    configureLogging({ dir, debug: true, toConsole: true });
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    logger('t').debug('d', { a: 1 }, new Error('boom'));
    await flush();
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][0]).toMatch(/d \{"a":1\} Error: boom/);
  });
});
