// OBS ブラウザソース用の HTTP + WebSocket サーバー。
// - GET /           → public/overlay.html（立ち絵・字幕・音声再生）
// - GET /char/*.png → 立ち絵画像
// - WS              → サーバー→画面: {type:'say', id, text, wav(base64)} / {type:'stop'}
//                     画面→サーバー: {type:'ended', id}（再生完了の通知）
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { WebSocketServer } from 'ws';
import { logger } from './log.js';

const log = logger('overlay');
const PUBLIC = path.resolve('public');
const TYPES = { '.html': 'text/html; charset=utf-8', '.png': 'image/png', '.js': 'text/javascript', '.css': 'text/css' };

export class Overlay extends EventEmitter {
  constructor({ port }) {
    super();
    this.port = port;
    this.clients = new Set();
  }

  // 公開フォルダ内のファイルパスを返す。外を指す・不正な・存在しない場合は null
  static resolvePublic(reqUrl) {
    let urlPath;
    try {
      urlPath = decodeURIComponent(new URL(reqUrl, 'http://x').pathname);
    } catch {
      return null; // 不正なエンコード
    }
    const file = path.resolve(PUBLIC, '.' + (urlPath === '/' ? '/overlay.html' : urlPath));
    const rel = path.relative(PUBLIC, file);
    // デコード後の "..\" なども、正規化したうえで公開フォルダの外なら拒否する
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
    if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) return null;
    return file;
  }

  // 待ち受けを始め、実際のポート番号を返す（port: 0 なら空きポート）
  start() {
    const server = http.createServer((req, res) => {
      const file = Overlay.resolvePublic(req.url);
      if (!file) {
        res.writeHead(404).end();
        return;
      }
      res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
      fs.createReadStream(file).pipe(res);
    });
    this.server = server;
    const wss = new WebSocketServer({ server });
    this.wss = wss;
    wss.on('connection', (ws) => {
      this.clients.add(ws);
      log.info(`オーバーレイ接続 (計 ${this.clients.size})`);
      ws.on('message', (raw) => {
        try {
          const m = JSON.parse(raw);
          if (m.type === 'ended') this.emit('ended', m.id);
        } catch {}
      });
      ws.on('close', () => {
        this.clients.delete(ws);
        log.warn(`オーバーレイ切断 (残 ${this.clients.size})`);
      });
    });
    return new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(this.port, '127.0.0.1', () => {
        const { port } = server.address();
        log.info(`オーバーレイ: http://127.0.0.1:${port}/`);
        resolve(port);
      });
    });
  }

  close() {
    for (const c of this.clients) c.terminate();
    this.wss?.close();
    return new Promise((r) => (this.server ? this.server.close(() => r()) : r()));
  }

  get hasClient() {
    return this.clients.size > 0;
  }

  broadcast(msg) {
    const s = JSON.stringify(msg);
    for (const c of this.clients) c.send(s);
  }
}
