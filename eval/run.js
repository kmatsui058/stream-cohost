// プロンプトの簡易評価: 評価ケースを、今の persona と比較用の persona（git の版）で実行し、返事を並べて書き出す。
//
//   npm run eval                         # 比較用は配信で使っていた版（DEFAULT_BASELINE）
//   npm run eval -- --baseline <git の版>
//
// 実際の Gemini Live を呼ぶので課金が発生し、結果も毎回変わる。CI では実行しない。
// 制約: ログに画面の画像が無いので、入力はテキストだけ（画面への反応は評価できない）。
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { GoogleGenAI, Modality } from '@google/genai';
import { configureLogging } from '../src/log.js';
import { loadConfig } from '../src/config.js';
import { idlePromptText } from '../src/director.js';
import { checkReply, summarize, CHECKS } from './checks.js';

const DEFAULT_BASELINE = '8ff7a55'; // 2026-10-18 の初配信で使っていた persona
const TIMEOUT_MS = 30000;
const CONCURRENCY = 2;

configureLogging({ toConsole: false });
const args = process.argv.slice(2);
const baseline = args.includes('--baseline') ? args[args.indexOf('--baseline') + 1] : DEFAULT_BASELINE;
const config = loadConfig();
const ai = new GoogleGenAI({ apiKey: config.gemini.apiKey });
const cases = JSON.parse(fs.readFileSync('eval/cases.json', 'utf8'));
const stream = JSON.parse(fs.readFileSync('eval/stream.json', 'utf8'));

const streamSection = `\n\n# 今日の配信\nタイトル: ${stream.title}\n概要欄:\n${stream.description}`;
const variants = [
  { name: `比較用（${baseline}）`, persona: execFileSync('git', ['show', `${baseline}:persona.md`], { encoding: 'utf8' }) },
  { name: '今の persona', persona: fs.readFileSync('persona.md', 'utf8') },
];

// 1 回の入力に対する相方の返事（出力の文字起こし）を受け取る
async function ask(systemInstruction, text) {
  let session;
  let out = '';
  const done = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('タイムアウト')), TIMEOUT_MS);
    ai.live
      .connect({
        model: config.gemini.model,
        config: { responseModalities: [Modality.AUDIO], systemInstruction, outputAudioTranscription: {} },
        callbacks: {
          onmessage: (m) => {
            const sc = m.serverContent;
            if (sc?.outputTranscription?.text) out += sc.outputTranscription.text;
            if (sc?.turnComplete) {
              clearTimeout(timer);
              resolve(out.trim());
            }
          },
          onerror: (e) => reject(new Error(e?.message ?? 'WebSocket エラー')),
          onclose: () => {},
        },
      })
      .then((s) => {
        session = s;
        s.sendRealtimeInput({ text });
      }, reject);
  });
  try {
    return await done;
  } finally {
    try { session?.close(); } catch {}
  }
}

const inputOf = (c) => (c.type === 'idle' ? idlePromptText(c.topic) : c.type === 'chat' ? `【チャット】\n${c.text}` : c.text);

// ケース × 版 を、同時に CONCURRENCY 個ずつ実行する
const jobs = cases.flatMap((c) => variants.map((v, vi) => ({ c, vi, v })));
const replies = cases.map(() => variants.map(() => null));
let next = 0;
let finished = 0;
await Promise.all(
  Array.from({ length: CONCURRENCY }, async () => {
    while (next < jobs.length) {
      const { c, vi, v } = jobs[next++];
      let reply;
      try {
        reply = await ask(v.persona + streamSection, inputOf(c));
      } catch (e) {
        reply = '';
        console.error(`失敗: ${c.id} / ${v.name}: ${e.message}`);
      }
      replies[cases.indexOf(c)][vi] = reply;
      process.stdout.write(`\r${++finished}/${jobs.length}`);
    }
  }),
);
process.stdout.write('\n');

// 書き出し
const flags = (r) => CHECKS.filter((c) => r[c.key]).map((c) => c.label).join('、') || '—';
const esc = (s) => (s || '（返事なし）').replace(/\|/g, '｜').replace(/\n/g, ' ');
const checked = replies.map((rs) => rs.map(checkReply));
const sums = variants.map((_, vi) => summarize(checked.map((cs) => cs[vi])));

let md = `# プロンプト評価 ${new Date().toLocaleString('ja-JP')}\n\n`;
md += `- モデル: ${config.gemini.model}\n- ケース: ${cases.length}（入力はテキストのみ。画面は見せていない）\n- 今日の配信: ${stream.title}\n\n`;
md += `## 集計（該当した返事の数 / ${cases.length}）\n\n| 項目 | ${variants.map((v) => v.name).join(' | ')} |\n|---|${variants.map(() => '---').join('|')}|\n`;
for (const c of CHECKS) md += `| ${c.label} | ${sums.map((s) => s[c.key]).join(' | ')} |\n`;
md += `\n## ケースごとの返事\n\n| ケース | 入力 | ${variants.map((v) => v.name).join(' | ')} |\n|---|---|${variants.map(() => '---').join('|')}|\n`;
cases.forEach((c, i) => {
  const input = c.type === 'idle' ? `（沈黙時の合図: 切り口 ${c.topic}）` : c.text;
  const cells = replies[i].map((r, vi) => `${esc(r)}<br>⚑ ${flags(checked[i][vi])}`);
  md += `| **${c.id}**<br>${c.note} | ${esc(input)} | ${cells.join(' | ')} |\n`;
});

fs.mkdirSync('eval/results', { recursive: true });
const file = path.join('eval/results', `${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.md`);
fs.writeFileSync(file, md);
console.log(`書き出しました: ${file}`);
for (const [vi, v] of variants.entries()) {
  console.log(`${v.name}: ${CHECKS.map((c) => `${c.label} ${sums[vi][c.key]}`).join(' / ')}`);
}
