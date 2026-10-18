// 進行役: 「いつ何を Gemini に渡し、返ってきたものをどう喋らせるか」を決める。
//
// - Gemini の出力文字起こしを溜め、句点などで文に切って Speaker に流す
// - Gemini から interrupted が来たら（配信者が割り込んだ）発話を止める
// - 無音が続いたら自発発話の合図テキストを注入する
// - YouTube チャットは溜めておき、場が空いたタイミングでまとめて注入する
import { logger } from './log.js';

const log = logger('director');

// 沈黙時に相方から話しかけるときの話題の切り口。毎回この中から選び、同じものは続けない
export const IDLE_TOPICS = [
  '画面に映っている具体的なもの（場所、敵、ドロップ、ステータス、装備など）を 1 つ選んで、配信者に質問してください。',
  '今の状況に関係する RO の小ネタを 1 つ話して、配信者の考えを聞いてください。確かなことだけを話してください。',
  '視聴者がチャットで答えやすい問いかけを、視聴者に向けてしてください。',
  'これまでの会話から話題を 1 つ拾い直して、その続きを配信者に聞いてください。',
  '今の状況や配信者の行動を観察して気づいたことや、自分なりの仮説を一言述べて、配信者に確かめてください。',
];
// どの切り口でも付ける締めの指示
export const IDLE_CLOSING =
  '観察したこと、そこから立てた仮説、理解するための具体的な問いのどれかで締めて、配信者や視聴者が答えたくなる形にしてください。' +
  '直前の発言とは違う角度から、新しい言い回しで話してください。';
const SENTENCE_END = /[^。！？!?♪\n]*[。！？!?♪\n]+/g;
const now = () => Date.now();

export class Director {
  constructor({ gemini, speaker, memory, cfg, random = Math.random, isAudible = () => true }) {
    this.gemini = gemini;
    this.speaker = speaker;
    this.memory = memory;
    this.cfg = cfg;
    this.random = random;
    // 相方の声が誰かに届く状態か（= 配信に重ねる画面がつながっているか）
    this.isAudible = isAudible;
    this.holding = false; // 画面が未接続のため自発発話を控えている
    this.lastTopic = -1; // 直前に使った話題の切り口
    this.buf = ''; // 文になりきっていない出力
    this.modelBusy = false; // Gemini が応答を生成中
    this.awaitingSince = 0; // テキスト注入後、応答待ちの開始時刻
    this.lastActivity = now(); // 誰かが最後に喋った時刻
    this.lastUserSpeech = 0;
    this.chatQueue = [];
    this.paused = false;
    this.nextIdleSec = this.rollIdle();

    gemini.on('userText', (t) => this.onUserText(t));
    gemini.on('modelText', (t) => this.onModelText(t));
    gemini.on('turnComplete', () => this.onTurnComplete());
    gemini.on('interrupted', () => this.onInterrupted());
    gemini.on('open', () => this.onSessionOpen());
    speaker.on('start', () => (this.lastActivity = now()));
    speaker.on('idle', () => (this.lastActivity = now()));
    this.timer = setInterval(() => this.tick(), 1000);
  }

  dispose() {
    clearInterval(this.timer);
  }

  rollIdle() {
    const { idleMinSec: a, idleMaxSec: b } = this.cfg;
    return a + this.random() * Math.max(0, b - a);
  }

  onUserText(t) {
    this.lastActivity = this.lastUserSpeech = now();
    log.debug(`🎤 ${t}`);
    this.memory?.add('配信者', t);
    // 相方が喋っている最中に配信者が話し始めたら黙らせる
    if (this.cfg.bargeIn && this.speaker.speaking && t.trim().length >= 2) this.speaker.stop();
  }

  onModelText(t) {
    if (this.paused) return;
    this.modelBusy = true;
    this.awaitingSince = 0;
    this.memory?.add('相方', t);
    this.buf += t;
    let consumed = 0;
    for (const m of this.buf.matchAll(SENTENCE_END)) {
      this.speaker.push(m[0]);
      consumed = m.index + m[0].length;
    }
    this.buf = this.buf.slice(consumed);
  }

  onTurnComplete() {
    if (!this.paused && this.buf.trim()) this.speaker.push(this.buf);
    this.buf = '';
    this.modelBusy = false;
    this.awaitingSince = 0;
  }

  onInterrupted() {
    log.info('Gemini 側で割り込み検知');
    this.buf = '';
    this.modelBusy = false;
    this.speaker.stop();
  }

  // セッションを張り直した直後。生成途中で切り替わった場合 turnComplete が来ないので状態を戻す
  onSessionOpen() {
    if (!this.paused && this.buf.trim()) this.speaker.push(this.buf);
    this.buf = '';
    this.modelBusy = false;
    this.awaitingSince = 0;
  }

  addChat(msgs) {
    this.chatQueue.push(...msgs);
    if (this.chatQueue.length > 20) this.chatQueue.splice(0, this.chatQueue.length - 20);
  }

  // 場が空いているか: 誰も喋っておらず、Gemini も考え中でない
  get quiet() {
    if (this.speaker.speaking || this.modelBusy) return false;
    if (this.awaitingSince && now() - this.awaitingSince < 15000) return false;
    return now() - this.lastUserSpeech > 3000;
  }

  inject(text) {
    if (!this.gemini.sendText(text)) return false;
    this.awaitingSince = now();
    this.lastActivity = now();
    return true;
  }

  // 直前と違う切り口を選び、合図の文を作る
  idlePrompt() {
    const n = IDLE_TOPICS.length;
    let i;
    if (this.lastTopic < 0) i = Math.floor(this.random() * n) % n;
    else {
      i = Math.floor(this.random() * (n - 1)) % (n - 1); // 直前のものを除いた n-1 個から選ぶ
      if (i >= this.lastTopic) i++;
    }
    this.lastTopic = i;
    return `【合図】配信者がしばらく黙っています。話し相手として話題を振ってください。${IDLE_TOPICS[i]}${IDLE_CLOSING}`;
  }

  // 誰かが話したのと同じ扱いにして、沈黙の数え直しを始める（画面がつながったときなど）
  markActivity() {
    this.lastActivity = now();
  }

  tick() {
    if (this.paused || !this.gemini.ready) return;
    // 画面が未接続なら、誰にも聞こえない発言をしないよう、合図とチャットの受け渡しを控える
    if (!this.isAudible()) {
      if (!this.holding) log.info('画面が未接続のため、自分から話しかけるのを控えます');
      this.holding = true;
      return;
    }
    if (this.holding) {
      this.holding = false;
      log.info('画面がつながったので、自分から話しかけるのを再開します');
    }
    if (!this.quiet) return;
    if (this.chatQueue.length) {
      const lines = this.chatQueue.slice(0, 5).map((m) => `${m.author}: ${m.text}`);
      // 送れたときだけキューから外して記録する（送れなければ次に場が空いたときに再送）
      if (this.inject(`【チャット】\n${lines.join('\n')}`)) {
        this.chatQueue.splice(0, lines.length);
        for (const l of lines) this.memory?.add('チャット', l);
      }
      return;
    }
    if (this.cfg.idleMinSec > 0 && now() - this.lastActivity > this.nextIdleSec * 1000) {
      this.nextIdleSec = this.rollIdle();
      this.inject(this.idlePrompt());
    }
  }

  setPaused(p) {
    this.paused = p;
    if (p) {
      this.speaker.stop();
      this.buf = '';
    }
    this.lastActivity = now();
    log.info(p ? '⏸ 一時停止（マイク・画面の送信と発話を止めます）' : '▶ 再開');
  }
}
