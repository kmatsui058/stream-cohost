// YouTube ライブチャット取得（YouTube Data API v3 をポーリング）。
// 1) videos.list で動画 ID → activeLiveChatId を引く
// 2) liveChatMessages.list を pageToken 付きで繰り返し呼ぶ（1 回 5 ユニット、既定上限 1 日 10,000 ユニット）
import { EventEmitter } from 'node:events';
import { logger } from './log.js';

const log = logger('youtube');
const API = 'https://www.googleapis.com/youtube/v3';
const MIN_POLL_MS = Number(process.env.CHAT_POLL_MIN_MS || 10000); // 10 秒間隔で約 2.7 時間/日

export class YouTubeChat extends EventEmitter {
  constructor({ apiKey }) {
    super();
    this.apiKey = apiKey;
    this.chatId = null;
    this.pageToken = null;
    this.timer = null;
  }

  async start(videoId) {
    this.stop();
    if (!this.apiKey || !videoId) {
      log.info('YOUTUBE_API_KEY / 動画 ID が無いのでチャット読み取りはオフ');
      return;
    }
    try {
      const r = await fetch(`${API}/videos?part=liveStreamingDetails&id=${videoId}&key=${this.apiKey}`);
      const j = await r.json();
      if (!r.ok) throw new Error(JSON.stringify(j.error?.message ?? j));
      this.chatId = j.items?.[0]?.liveStreamingDetails?.activeLiveChatId;
      if (!this.chatId) throw new Error('activeLiveChatId が見つかりません（配信中の動画 ID か確認）');
      log.info(`チャット取得開始 video=${videoId}`);
      this.pageToken = null;
      this.poll(true);
    } catch (e) {
      log.error('チャット開始失敗', e.message);
    }
  }

  async poll(first = false) {
    let wait = MIN_POLL_MS;
    try {
      const qs = new URLSearchParams({ liveChatId: this.chatId, part: 'snippet,authorDetails', key: this.apiKey });
      if (this.pageToken) qs.set('pageToken', this.pageToken);
      const r = await fetch(`${API}/liveChat/messages?${qs}`);
      const j = await r.json();
      if (!r.ok) {
        if (r.status === 403) log.error('403: 権限エラーかクォータ超過です', j.error?.message);
        throw new Error(j.error?.message ?? r.status);
      }
      this.pageToken = j.nextPageToken;
      wait = Math.max(j.pollingIntervalMillis ?? 0, MIN_POLL_MS);
      // 起動直後の取得分は過去ログなので読まない
      const msgs = first ? [] : (j.items ?? [])
        .filter((i) => i.snippet?.type === 'textMessageEvent' || i.snippet?.type === 'superChatEvent')
        .map((i) => ({ author: i.authorDetails?.displayName ?? '?', text: i.snippet.displayMessage ?? '' }));
      if (msgs.length) {
        for (const m of msgs) log.info(`💬 ${m.author}: ${m.text}`);
        this.emit('messages', msgs);
      }
    } catch (e) {
      log.warn('チャット取得エラー', e.message);
      wait = 30000;
    }
    this.timer = setTimeout(() => this.poll(), wait);
  }

  stop() {
    clearTimeout(this.timer);
    this.timer = null;
  }
}
