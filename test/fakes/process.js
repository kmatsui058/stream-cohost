// 子プロセスの偽物。stdout / stderr にデータを流し込み、exit を発火できる。
import { EventEmitter } from 'node:events';

export function fakeSpawner() {
  const calls = [];
  const spawn = (cmd, args, opts) => {
    const proc = new EventEmitter();
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    proc.killed = false;
    proc.kill = () => {
      proc.killed = true;
      proc.emit('exit', null);
    };
    calls.push({ cmd, args, opts, proc });
    return proc;
  };
  return { spawn, calls, last: () => calls.at(-1).proc };
}
