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

  start() {
    const server = http.createServer((req, res) => {
      const urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);
      const file = path.join(PUBLIC, urlPath === '/' ? 'overlay.html' : urlPath);
      if (!file.startsWith(PUBLIC) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
        res.writeHead(404).end();
        return;
      }
      res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
      fs.createReadStream(file).pipe(res);
    });
    const wss = new WebSocketServer({ server });
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
    server.listen(this.port, '127.0.0.1', () => log.info(`オーバーレイ: http://127.0.0.1:${this.port}/`));
  }

  get hasClient() {
    return this.clients.size > 0;
  }

  broadcast(msg) {
    const s = JSON.stringify(msg);
    for (const c of this.clients) c.send(s);
  }
}
