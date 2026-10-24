// OBS ブラウザソース用の HTTP + WebSocket サーバー。
// - GET /                                → public/overlay.html（立ち絵または SOUND ONLY・字幕・音声再生）
// - GET /character/{default,smile}.png → 立ち絵（CHARACTER_DIR から。素材は再配布禁止なのでリポジトリには置かない）
// - WS → サーバー→画面: 接続時に {type:'profile', name, character, present}、{type:'say', id, text, wav(base64)}、{type:'stop'}、
//        {type:'presence', visible}（召喚で表示、退去で非表示）、{type:'thinking', on}（考え中）
//        画面→サーバー: {type:'ended', id}（再生完了の通知）
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { WebSocketServer } from 'ws';
import { logger } from './log.js';

const log = logger('overlay');
const PUBLIC = path.resolve('public');
const TYPES = { '.html': 'text/html; charset=utf-8', '.png': 'image/png', '.js': 'text/javascript', '.css': 'text/css' };
const CHARACTER_FILES = ['default.png', 'smile.png'];
const THINKING_FILE = 'misterious.png'; // 考え中の表情（なくてもよい）

export class Overlay extends EventEmitter {
  constructor({ port, displayName = '', characterDir = '' }) {
    super();
    this.port = port;
    this.displayName = displayName;
    this.characterDir = characterDir;
    this.clients = new Set();
    this.present = false; // 相方を表示しているか（召喚中）
    this.thinking = false; // 考え中（答える役に問い合わせ中）か
  }

  // 考え中の画像があるか
  get hasThinkingFace() {
    return this.hasCharacter && fs.existsSync(path.join(this.characterDir, THINKING_FILE));
  }

  // 問い合わせ中は、画面に考え中の表情と「…」を出す
  setThinking(on) {
    this.thinking = on;
    this.broadcast({ type: 'thinking', on });
  }

  // 召喚・退去に合わせて、画面に相方を出す／消す
  setPresence(visible) {
    this.present = visible;
    this.broadcast({ type: 'presence', visible });
  }

  // 立ち絵フォルダに default.png と smile.png の両方があるか
  get hasCharacter() {
    return !!this.characterDir && CHARACTER_FILES.every((f) => fs.existsSync(path.join(this.characterDir, f)));
  }

  // 配信するファイルのパスを返す。外を指す・不正な・存在しない場合は null
  resolve(reqUrl) {
    let urlPath;
    try {
      urlPath = decodeURIComponent(new URL(reqUrl, 'http://x').pathname);
    } catch {
      return null; // 不正なエンコード
    }
    // 立ち絵は決まった 2 つのファイル名だけを、立ち絵フォルダから返す（名前の照合なので外には出られない）
    if (urlPath.startsWith('/character/')) {
      const name = urlPath.slice('/character/'.length);
      if (!this.characterDir || ![...CHARACTER_FILES, THINKING_FILE].includes(name)) return null;
      const file = path.join(this.characterDir, name);
      return fs.existsSync(file) ? file : null;
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
      const file = this.resolve(req.url);
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
      ws.send(JSON.stringify({ type: 'profile', name: this.displayName, character: this.hasCharacter, present: this.present, thinkingFace: this.hasThinkingFace, thinking: this.thinking }));
      this.emit('connect');
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
