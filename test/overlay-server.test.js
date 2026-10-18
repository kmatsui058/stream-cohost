import fs from 'node:fs';
import os from 'node:os';
import http from 'node:http';
import path from 'node:path';
import { describe, it, expect, afterEach } from 'vitest';
import WebSocket from 'ws';
import { Overlay } from '../src/overlay.js';

// fetch は URL を正規化してしまうので、生のパスを送れる http.get を使う
const get = (port, rawPath) =>
  new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: rawPath }, (res) => {
      let body = '';
      res.on('data', (d) => (body += d));
      res.on('end', () => resolve({ status: res.statusCode, type: res.headers['content-type'], body }));
    }).on('error', reject);
  });

const open = (port) =>
  new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    ws.received = [];
    ws.on('message', (d) => ws.received.push(JSON.parse(d)));
    ws.on('open', () => resolve(ws));
  });

const until = async (cond) => {
  for (let i = 0; i < 100 && !cond(); i++) await new Promise((r) => setTimeout(r, 10));
  expect(cond()).toBe(true);
};

describe('stream-overlay（サーバー側）', () => {
  let overlay;
  const sockets = [];
  afterEach(async () => {
    sockets.splice(0).forEach((s) => s.close());
    await overlay?.close();
  });
  const start = async () => {
    overlay = new Overlay({ port: 0 });
    return overlay.start();
  };

  describe('画面と素材を配信する', () => {
    it('ルートを開く: 配信用の画面の HTML を返す', async () => {
      const port = await start();
      const r = await get(port, '/');
      expect(r.status).toBe(200);
      expect(r.type).toMatch(/text\/html/);
      expect(r.body).toContain('<html');
    });

    it('公開フォルダ内の JS を返す', async () => {
      const port = await start();
      const r = await get(port, '/overlay-core.js');
      expect(r.status).toBe(200);
      expect(r.type).toMatch(/javascript/);
    });

    it.each([
      '/../package.json',
      '/..%2fpackage.json',
      '/..%5cpackage.json',
      '/%2e%2e%5cpackage.json',
      '/..%5c..%5cWindows%5cwin.ini',
    ])('公開フォルダの外を指定する（%s）: 404', async (p) => {
      const port = await start();
      const r = await get(port, p);
      expect(r.status).toBe(404);
      expect(r.body).not.toContain('"name"');
    });

    it('名前が public で始まる隣のフォルダ: 404', async () => {
      const sibling = path.resolve('public-cohost-test');
      fs.mkdirSync(sibling, { recursive: true });
      fs.writeFileSync(path.join(sibling, 'secret.txt'), 'SECRET');
      try {
        const port = await start();
        const r = await get(port, '/..%5cpublic-cohost-test%5csecret.txt');
        expect(r.status).toBe(404);
        expect(r.body).not.toContain('SECRET');
      } finally {
        fs.rmSync(sibling, { recursive: true, force: true });
      }
    });

    it('存在しない画像: 404', async () => {
      const port = await start();
      expect((await get(port, '/char/nothing.png')).status).toBe(404);
    });

    it('不正なエンコードのパス: 404 を返し、サーバーは動き続ける', async () => {
      const port = await start();
      expect((await get(port, '/%E0%A4%A')).status).toBe(404);
      expect((await get(port, '/')).status).toBe(200);
    });
  });

  describe('再生の指示と中断を届ける', () => {
    it('画面が 2 つ接続している: 両方に同じ指示が届く', async () => {
      const port = await start();
      sockets.push(await open(port), await open(port));
      await until(() => overlay.clients.size === 2);
      expect(overlay.hasClient).toBe(true);
      overlay.broadcast({ type: 'say', id: 1, text: 'やあ', wav: 'AA==' });
      overlay.broadcast({ type: 'stop' });
      const cmds = (s) => s.received.filter((m) => m.type !== 'profile');
      await until(() => sockets.every((s) => cmds(s).length === 2));
      for (const s of sockets) expect(cmds(s)).toEqual([{ type: 'say', id: 1, text: 'やあ', wav: 'AA==' }, { type: 'stop' }]);
    });

    const charDir = (files) => {
      const base = fs.mkdtempSync(path.join(os.tmpdir(), 'cohost-char-'));
      const dir = path.join(base, 'char');
      fs.mkdirSync(dir);
      for (const f of files) fs.writeFileSync(path.join(dir, f), `PNG:${f}`);
      fs.writeFileSync(path.join(base, 'secret.txt'), 'SECRET'); // 立ち絵フォルダの 1 つ上
      return dir;
    };
    const profileOf = async (characterDir) => {
      overlay = new Overlay({ port: 0, displayName: 'ORÐA-VÁR', characterDir });
      const port = await overlay.start();
      const ws = await open(port);
      sockets.push(ws);
      await until(() => ws.received.length === 1);
      return ws.received[0];
    };

    it('表示名と立ち絵の有無 / 立ち絵ありで画面が接続する: 表示名と「立ち絵あり」を送る', async () => {
      expect(await profileOf(charDir(['default.png', 'smile.png']))).toEqual({ type: 'profile', name: 'ORÐA-VÁR', character: true });
    });

    it('表示名と立ち絵の有無 / 立ち絵が片方しかない: 「立ち絵なし」を送る', async () => {
      expect(await profileOf(charDir(['default.png']))).toEqual({ type: 'profile', name: 'ORÐA-VÁR', character: false });
    });

    it('表示名と立ち絵の有無 / 立ち絵フォルダが未設定: 「立ち絵なし」を送る', async () => {
      expect(await profileOf('')).toEqual({ type: 'profile', name: 'ORÐA-VÁR', character: false });
    });

    it('立ち絵の画像を配信する / 立ち絵を取得する: フォルダ内の smile.png を返す', async () => {
      overlay = new Overlay({ port: 0, characterDir: charDir(['default.png', 'smile.png', 'angry.png']) });
      const port = await overlay.start();
      const r = await get(port, '/character/smile.png');
      expect(r.status).toBe(200);
      expect(r.type).toBe('image/png');
      expect(r.body).toBe('PNG:smile.png');
    });

    it.each(['/character/angry.png', '/character/..%2fsecret.txt', '/character/..%5csecret.txt', '/character/'])(
      '立ち絵の画像を配信する / ほかのファイルを指定する（%s）: 404',
      async (p) => {
        overlay = new Overlay({ port: 0, characterDir: charDir(['default.png', 'smile.png', 'angry.png']) });
        const port = await overlay.start();
        const r = await get(port, p);
        expect(r.status).toBe(404);
        expect(r.body).not.toContain('SECRET');
      },
    );

    it('立ち絵フォルダが未設定なら /character/ は 404', async () => {
      overlay = new Overlay({ port: 0 });
      const port = await overlay.start();
      expect((await get(port, '/character/default.png')).status).toBe(404);
    });

    it('画面が新しく接続するたびに connect を 1 回出す', async () => {
      const port = await start();
      let n = 0;
      overlay.on('connect', () => n++);
      sockets.push(await open(port), await open(port));
      await until(() => n === 2);
    });

    it('切断した画面は数えない', async () => {
      const port = await start();
      const ws = await open(port);
      await until(() => overlay.hasClient);
      ws.close();
      await until(() => !overlay.hasClient);
    });
  });

  describe('再生完了を受け取る', () => {
    it('識別子つきの再生完了を伝え、不正なデータは無視する', async () => {
      const port = await start();
      const ws = await open(port);
      sockets.push(ws);
      const ended = [];
      overlay.on('ended', (id) => ended.push(id));
      ws.send('not json');
      ws.send(JSON.stringify({ type: 'other' }));
      ws.send(JSON.stringify({ type: 'ended', id: 7 }));
      await until(() => ended.length === 1);
      expect(ended).toEqual([7]);
    });
  });
});
