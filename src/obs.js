// 映像入力: obs-websocket の GetSourceScreenshot で配信画面を JPEG で取る。
// 画面キャプチャや仮想カメラを別途用意しなくても「視聴者が見ている画面」をそのまま渡せる。
import { OBSWebSocket } from 'obs-websocket-js';
import { EventEmitter } from 'node:events';
import { logger } from './log.js';

const log = logger('obs');

export class ObsCapture extends EventEmitter {
  constructor(cfg) {
    super();
    this.cfg = cfg;
    this.obs = new OBSWebSocket();
    this.connected = false;
    this.timer = null;
    this.busy = false;
    this.obs.on('ConnectionClosed', () => {
      if (this.connected) log.warn('OBS から切断されました。5 秒後に再接続します');
      this.connected = false;
      setTimeout(() => this.connect(), 5000);
    });
  }

  async connect() {
    try {
      await this.obs.connect(this.cfg.url, this.cfg.password);
      this.connected = true;
      log.info(`OBS に接続: ${this.cfg.url}`);
    } catch (e) {
      // 失敗時は ConnectionClosed が飛んで再試行される
      log.warn(`OBS 接続失敗: ${e.message}`);
    }
  }

  start() {
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
}
