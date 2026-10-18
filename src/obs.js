// 映像入力: obs-websocket の GetSourceScreenshot で配信画面を JPEG で取る。
// 画面キャプチャや仮想カメラを別途用意しなくても「視聴者が見ている画面」をそのまま渡せる。
import { OBSWebSocket } from 'obs-websocket-js';
import { EventEmitter } from 'node:events';
import { logger } from './log.js';

const log = logger('obs');
const RECONNECT_MS = 5000;

export class ObsCapture extends EventEmitter {
  constructor(cfg, { client = new OBSWebSocket() } = {}) {
    super();
    this.cfg = cfg;
    this.obs = client;
    this.connected = false;
    this.connecting = false;
    this.reconnectTimer = null;
    this.timer = null;
    this.busy = false;
    this.stopped = false;
    this.obs.on('ConnectionClosed', () => {
      if (this.connected) log.warn(`OBS から切断されました。${RECONNECT_MS / 1000} 秒後に再接続します`);
      this.connected = false;
      this.scheduleReconnect();
    });
  }

  // 再接続の予約はここだけ。初回の失敗と切断イベントが重なっても 1 つしか予約しない
  scheduleReconnect() {
    if (this.reconnectTimer || this.stopped) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, RECONNECT_MS);
  }

  async connect() {
    if (this.connected || this.connecting) return;
    this.connecting = true;
    try {
      await this.obs.connect(this.cfg.url, this.cfg.password);
      this.connected = true;
      log.info(`OBS に接続: ${this.cfg.url}`);
    } catch (e) {
      log.warn(`OBS 接続失敗: ${e.message}`);
      this.scheduleReconnect();
    } finally {
      this.connecting = false;
    }
  }

  start() {
    this.stopped = false;
    this.connect();
    this.timer = setInterval(() => this.capture(), this.cfg.frameIntervalMs);
  }

  async capture() {
    if (!this.connected || this.busy) return;
    this.busy = true;
    try {
      let sourceName = this.cfg.sourceName;
      if (!sourceName) ({ currentProgramSceneName: sourceName } = await this.obs.call('GetCurrentProgramScene'));
      const { imageData } = await this.obs.call('GetSourceScreenshot', {
        sourceName,
        imageFormat: 'jpg',
        imageWidth: this.cfg.frameWidth,
        imageCompressionQuality: 70,
      });
      // imageData は "data:image/jpg;base64,...." 形式
      this.emit('frame', imageData.slice(imageData.indexOf(',') + 1));
    } catch (e) {
      log.warn(`スクリーンショット失敗: ${e.message}`);
    } finally {
      this.busy = false;
    }
  }

  stop() {
    this.stopped = true;
    clearInterval(this.timer);
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.obs.disconnect?.();
  }
}
