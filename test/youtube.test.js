import fs from 'node:fs';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { YouTubeChat } from '../src/youtube.js';
import { logFilePath } from '../src/log.js';

const json = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });
const video = (chatId = 'chat-1') =>
  json({ items: [{ snippet: { title: `配信 ${chatId}`, description: `概要 ${chatId}` }, liveStreamingDetails: { activeLiveChatId: chatId } }] });
const msg = (type, name, text) => ({ snippet: { type, displayMessage: text }, authorDetails: { displayName: name } });
const page = (items, next = 'p', interval = 2000) => json({ items, nextPageToken: next, pollingIntervalMillis: interval });

// URL ごとに応答を返す fetch の偽物。liveChat/messages は積んだ順に返す
function fakeFetch() {
  const pages = {};
  const f = vi.fn(async (url) => {
    const u = new URL(url);
    if (u.pathname.endsWith('/videos')) return video(`chat-${u.searchParams.get('id')}`);
    const q = pages[u.searchParams.get('liveChatId')] ?? [];
    return q.length ? q.shift() : page([]);
  });
  f.pages = pages;
  f.chatCalls = (id) => f.mock.calls.filter(([url]) => url.includes('liveChat') && url.includes(`liveChatId=${id}`)).length;
  return f;
}

const readLog = async () => {
  vi.useRealTimers();
  await new Promise((r) => setTimeout(r, 50));
  return fs.readFileSync(logFilePath(), 'utf8');
};

describe('live-chat', () => {
  let f, chat, got;
  beforeEach(() => {
    vi.useFakeTimers();
    f = fakeFetch();
    got = [];
  });
  afterEach(() => {
    chat?.stop();
    vi.useRealTimers();
  });
  const make = (apiKey = 'KEY', pollMinMs = 10000) => {
    chat = new YouTubeChat({ apiKey, pollMinMs }, { fetch: f });
    chat.on('messages', (m) => got.push(...m));
    return chat;
  };

  describe('対象の配信を特定する', () => {
    it('API キーがない: 取得せず、オフである旨を記録する', async () => {
      await make('').start('v1');
      expect(f).not.toHaveBeenCalled();
      expect(await readLog()).toContain('チャット読み取りはオフ');
    });

    it('配信中ではない動画: エラーを記録して取得を始めない', async () => {
      f.mockImplementationOnce(async () => json({ items: [{ snippet: { title: '終わった配信', description: 'd' }, liveStreamingDetails: {} }] }));
      await make().start('v1');
      await vi.advanceTimersByTimeAsync(60000);
      expect(f).toHaveBeenCalledTimes(1);
      expect(await readLog()).toMatch(/ERROR .*activeLiveChatId が見つかりません/);
    });

    it('動画 ID から activeLiveChatId を引き、API キーつきで取得する', async () => {
      await make().start('v1');
      const [videosUrl] = f.mock.calls[0];
      expect(videosUrl).toContain('/videos?part=snippet,liveStreamingDetails&id=v1&key=KEY');
      const [chatUrl] = f.mock.calls[1];
      const u = new URL(chatUrl);
      expect(u.searchParams.get('liveChatId')).toBe('chat-v1');
      expect(u.searchParams.get('part')).toBe('snippet,authorDetails');
      expect(u.searchParams.get('key')).toBe('KEY');
    });
  });

  describe('stream-info / 配信のタイトルと概要欄を取得する', () => {
    it('配信を指定する: 1 回の問い合わせでタイトルと概要欄を知らせる', async () => {
      const infos = [];
      make().on('info', (i) => infos.push(i));
      await chat.start('v1');
      expect(infos).toEqual([{ videoId: 'v1', title: '配信 chat-v1', description: '概要 chat-v1' }]);
      expect(f.mock.calls.filter(([u]) => u.includes('/videos?'))).toHaveLength(1);
    });

    it('ライブチャットのない動画: タイトルと概要欄は知らせ、チャットは始めない', async () => {
      f.mockImplementationOnce(async () => json({ items: [{ snippet: { title: '終わった配信', description: 'd' }, liveStreamingDetails: {} }] }));
      const infos = [];
      make().on('info', (i) => infos.push(i));
      await chat.start('v9');
      await vi.advanceTimersByTimeAsync(30000);
      expect(infos).toEqual([{ videoId: 'v9', title: '終わった配信', description: 'd' }]);
      expect(f).toHaveBeenCalledTimes(1);
    });
  });

  describe('新着コメントだけを届ける', () => {
    it('取得開始時に過去のコメントがある: 届けない', async () => {
      f.pages['chat-v1'] = [page(Array.from({ length: 10 }, (_, i) => msg('textMessageEvent', `u${i}`, 'old')))];
      await make().start('v1');
      await vi.advanceTimersByTimeAsync(0);
      expect(got).toEqual([]);
    });

    it('種類が混在する: 通常のコメントとスーパーチャットだけを届く順に届ける', async () => {
      f.pages['chat-v1'] = [
        page([], 'p1'),
        page([
          msg('textMessageEvent', 'Aさん', 'こんにちは'),
          msg('newSponsorEvent', 'Bさん', 'メンバーになりました'),
          msg('superChatEvent', 'Cさん', '¥500 がんばれ'),
        ]),
      ];
      await make().start('v1');
      await vi.advanceTimersByTimeAsync(10000);
      expect(got).toEqual([
        { author: 'Aさん', text: 'こんにちは' },
        { author: 'Cさん', text: '¥500 がんばれ' },
      ]);
    });

    it('前回の nextPageToken を使って続きを取る', async () => {
      f.pages['chat-v1'] = [page([], 'TOKEN1')];
      await make().start('v1');
      await vi.advanceTimersByTimeAsync(10000);
      const last = new URL(f.mock.calls.at(-1)[0]);
      expect(last.searchParams.get('pageToken')).toBe('TOKEN1');
    });
  });

  describe('取得の間隔', () => {
    it('API が短い待ち時間を示す: 最小間隔の 10 秒後に取得する', async () => {
      f.pages['chat-v1'] = [page([], 'p', 2000)];
      await make().start('v1');
      await vi.advanceTimersByTimeAsync(9999);
      expect(f.chatCalls('chat-v1')).toBe(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(f.chatCalls('chat-v1')).toBe(2);
    });

    it('API の待ち時間の方が長ければ、そちらに従う', async () => {
      f.pages['chat-v1'] = [page([], 'p', 15000)];
      await make().start('v1');
      await vi.advanceTimersByTimeAsync(14999);
      expect(f.chatCalls('chat-v1')).toBe(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(f.chatCalls('chat-v1')).toBe(2);
    });

    it('権限エラー: 権限かクォータの問題として記録し、30 秒後に再試行する', async () => {
      f.pages['chat-v1'] = [json({ error: { message: 'quotaExceeded' } }, 403)];
      await make().start('v1');
      await vi.advanceTimersByTimeAsync(29999);
      expect(f.chatCalls('chat-v1')).toBe(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(f.chatCalls('chat-v1')).toBe(2);
      expect(await readLog()).toMatch(/ERROR .*403: 権限エラーかクォータ超過です quotaExceeded/);
    });
  });

  describe('対象の配信の決め方', () => {
    it('同じ配信枠が読み取られ続ける: 今の対象と同じ動画 ID ではやり直さない', async () => {
      await make().start('v1');
      await chat.start('v1');
      expect(f.mock.calls.filter(([u]) => u.includes('/videos?'))).toHaveLength(1);
    });

    it('前回の開始に失敗した動画 ID は、もう一度指定すればやり直す', async () => {
      f.mockImplementationOnce(async () => json({ items: [{ snippet: { title: 't', description: 'd' }, liveStreamingDetails: {} }] }));
      await make().start('v1');
      await chat.start('v1');
      expect(f.mock.calls.filter(([u]) => u.includes('/videos?'))).toHaveLength(2);
    });
  });

  describe('対象の配信を切り替える', () => {
    it('動画 ID を変更する: 以前の配信の取得は行われなくなり、新しい配信を 1 本のループで取得する', async () => {
      // v1 の 2 回目の取得を通信中のまま止めておき、その間に v2 へ切り替える
      let release;
      f.pages['chat-v1'] = [page([], 'v1-p1'), new Promise((r) => (release = r))];
      await make().start('v1');
      await vi.advanceTimersByTimeAsync(10000); // v1 の 2 回目（通信中で止まる）
      expect(f.chatCalls('chat-v1')).toBe(2);
      await chat.start('v2'); // v2 の初回取得（t=10s）
      release(page([msg('textMessageEvent', '旧', 'old')], 'v1-p2'));
      await vi.advanceTimersByTimeAsync(60000); // t=70s まで
      expect(f.chatCalls('chat-v1')).toBe(2);
      // v2 は 10 秒ごとに 1 本だけ: 初回 + 6 回
      expect(f.chatCalls('chat-v2')).toBe(7);
      expect(got.find((m) => m.author === '旧')).toBeUndefined();
      // 古い応答のページトークンで v2 の続きを取らない
      const tokens = f.mock.calls.map(([u]) => new URL(u).searchParams.get('pageToken'));
      expect(tokens).not.toContain('v1-p2');
    });
  });
});
