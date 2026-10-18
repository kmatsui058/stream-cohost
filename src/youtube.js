// YouTube ライブチャット取得（YouTube Data API v3 をポーリング）。
// 1) videos.list で動画 ID → activeLiveChatId を引く
// 2) liveChatMessages.list を pageToken 付きで繰り返し呼ぶ（1 回 5 ユニット、既定上限 1 日 10,000 ユニット）
import { EventEmitter } from 'node:events';
import { logger } from './log.js';

const log = logger('youtube');
const API = 'https://www.googleapis.com/youtube/v3';
const MIN_POLL_MS = 10000; // 既定値。10 秒間隔で約 2.7 時間/日（設定は config.js の CHAT_POLL_MIN_MS）

export class YouTubeChat extends EventEmitter {
  constructor({ apiKey, pollMinMs = MIN_POLL_MS }, { fetch: fetchFn = fetch } = {}) {
    super();
    this.apiKey = apiKey;
    this.pollMinMs = pollMinMs;
    this.fetch = fetchFn;
    this.chatId = null;
    this.pageToken = null;
    this.timer = null;
    // 取得ループの世代番号。切り替え・停止で進め、通信中だった古いループの結果を捨てる
    // （捨てないと古いループが次の取得を予約し、ループが 2 本並走して利用枠を倍消費する）
    this.gen = 0;
  }

  async start(videoId) {
    // 今まさに読み取っている配信と同じなら、やり直さない（OBS から同じ ID が届き続けても安全）
    if (videoId && videoId === this.videoId && this.chatId) return;
    this.stop();
    this.chatId = null;
    this.videoId = videoId;
    const gen = this.gen;
    if (!this.apiKey || !videoId) {
      log.info('YOUTUBE_API_KEY / 動画 ID が無いのでチャット読み取りはオフ');
      return;
    }
    try {
      const r = await this.fetch(`${API}/videos?part=snippet,liveStreamingDetails&id=${videoId}&key=${this.apiKey}`);
      const j = await r.json();
      if (gen !== this.gen) return; // 待っている間にまた切り替えられた
      if (!r.ok) throw new Error(JSON.stringify(j.error?.message ?? j));
      const item = j.items?.[0];
      // 配信のタイトルと概要欄は、チャットの有無にかかわらず知らせる（相方のコンテキストに載せる）
      if (item?.snippet) this.emit('info', { videoId, title: item.snippet.title ?? '', description: item.snippet.description ?? '' });
      const chatId = item?.liveStreamingDetails?.activeLiveChatId;
      if (!chatId) throw new Error('activeLiveChatId が見つかりません（配信中の動画 ID か確認）');
      log.info(`チャット取得開始 video=${videoId}`);
      this.chatId = chatId;
      this.pageToken = null;
      this.poll(gen, true);
    } catch (e) {
      log.error('チャット開始失敗', e.message);
    }
  }

  async poll(gen, first = false) {
    let wait = this.pollMinMs;
    try {
      const qs = new URLSearchParams({ liveChatId: this.chatId, part: 'snippet,authorDetails', key: this.apiKey });
      if (this.pageToken) qs.set('pageToken', this.pageToken);
      const r = await this.fetch(`${API}/liveChat/messages?${qs}`);
      const j = await r.json();
      if (gen !== this.gen) return; // 切り替え・停止後に返ってきた古い応答は捨てる
      if (!r.ok) {
        if (r.status === 403) log.error('403: 権限エラーかクォータ超過です', j.error?.message);
        throw new Error(j.error?.message ?? r.status);
      }
      this.pageToken = j.nextPageToken;
      wait = Math.max(j.pollingIntervalMillis ?? 0, this.pollMinMs);
      // 起動直後の取得分は過去ログなので読まない
      const msgs = first ? [] : (j.items ?? [])
        .filter((i) => i.snippet?.type === 'textMessageEvent' || i.snippet?.type === 'superChatEvent')
        .map((i) => ({ author: i.authorDetails?.displayName ?? '?', text: i.snippet.displayMessage ?? '' }));
      if (msgs.length) {
        for (const m of msgs) log.info(`💬 ${m.author}: ${m.text}`);
        this.emit('messages', msgs);
      }
    } catch (e) {
      if (gen !== this.gen) return;
      log.warn('チャット取得エラー', e.message);
      wait = 30000;
    }
    this.timer = setTimeout(() => this.poll(gen), wait);
  }

  stop() {
    this.gen++;
    clearTimeout(this.timer);
    this.timer = null;
  }
}
