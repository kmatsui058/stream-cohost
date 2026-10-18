// プロンプトの簡易評価: 評価ケースを、複数の条件（persona・モデル・考える量）で実行し、返事を並べて書き出す。
//
//   npm run eval                                        # 配信で使っていた persona と今の persona を比べる
//   npm run eval -- --baseline <git の版>               # 比較用の persona の版を変える
//   npm run eval -- --experiment eval/experiments/depth.json   # 条件を設定ファイルで指定する
//
// 設定ファイルの variants: [{ name, persona: "file:<パス>" | "git:<版>", model?, thinkingLevel? }]
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
const TIMEOUT_MS = 60000; // 考える量を増やすと遅くなるので長めに
const CONCURRENCY = 2;

configureLogging({ toConsole: false });
const args = process.argv.slice(2);
const argOf = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const config = loadConfig();
const ai = new GoogleGenAI({ apiKey: config.gemini.apiKey });
const cases = JSON.parse(fs.readFileSync('eval/cases.json', 'utf8'));
const stream = JSON.parse(fs.readFileSync('eval/stream.json', 'utf8'));
const streamSection = `\n\n# 今日の配信\nタイトル: ${stream.title}\n概要欄:\n${stream.description}`;

function loadPersona(spec) {
  if (spec.startsWith('git:')) return execFileSync('git', ['show', `${spec.slice(4)}:persona.md`], { encoding: 'utf8' });
  if (spec.startsWith('file:')) return fs.readFileSync(spec.slice(5), 'utf8');
  throw new Error(`persona の指定が不正です: ${spec}`);
}

const experimentFile = argOf('--experiment');
const baseline = argOf('--baseline') ?? DEFAULT_BASELINE;
const experiment = experimentFile
  ? JSON.parse(fs.readFileSync(experimentFile, 'utf8'))
  : {
      description: '配信で使っていた persona と今の persona の比較',
      variants: [
        { name: `比較用（${baseline}）`, persona: `git:${baseline}` },
        { name: '今の persona', persona: 'file:persona.md' },
      ],
    };
const variants = experiment.variants.map((v) => ({
  ...v,
  model: v.model ?? config.gemini.model,
  instruction: loadPersona(v.persona) + streamSection,
}));

// 1 回の入力に対する相方の返事（出力の文字起こし）と、返事が終わるまでの時間を受け取る
async function ask(v, text) {
  let session;
  let out = '';
  let t0;
  let firstMs = null;
  const liveConfig = { responseModalities: [Modality.AUDIO], systemInstruction: v.instruction, outputAudioTranscription: {} };
  if (v.thinkingLevel) liveConfig.thinkingConfig = { thinkingLevel: v.thinkingLevel };
  const done = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('タイムアウト')), TIMEOUT_MS);
    ai.live
      .connect({
        model: v.model,
        config: liveConfig,
        callbacks: {
          onmessage: (m) => {
            const sc = m.serverContent;
            if (sc?.outputTranscription?.text) {
              if (firstMs == null) firstMs = Date.now() - t0;
              out += sc.outputTranscription.text;
            }
            if (sc?.turnComplete) {
              clearTimeout(timer);
              resolve({ text: out.trim(), ms: Date.now() - t0, firstMs });
            }
          },
          onerror: (e) => reject(new Error(e?.message ?? 'WebSocket エラー')),
          onclose: (e) => e?.code && e.code !== 1000 && reject(new Error(`切断 ${e.code} ${e.reason ?? ''}`)),
        },
      })
      .then((s) => {
        session = s;
        t0 = Date.now();
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

// ケース × 条件 を、同時に CONCURRENCY 個ずつ実行する
const jobs = cases.flatMap((c, ci) => variants.map((v, vi) => ({ c, ci, v, vi })));
const replies = cases.map(() => variants.map(() => null));
let next = 0;
let finished = 0;
await Promise.all(
  Array.from({ length: CONCURRENCY }, async () => {
    while (next < jobs.length) {
      const { c, ci, v, vi } = jobs[next++];
      try {
        replies[ci][vi] = await ask(v, inputOf(c));
      } catch (e) {
        replies[ci][vi] = { text: '', ms: null, firstMs: null, error: e.message };
        console.error(`\n失敗: ${c.id} / ${v.name}: ${e.message}`);
      }
      process.stdout.write(`\r${++finished}/${jobs.length}`);
    }
  }),
);
process.stdout.write('\n');

// 書き出し
const flags = (r) => CHECKS.filter((c) => r[c.key]).map((c) => c.label).join('、') || '—';
const esc = (s) => (s || '（返事なし）').replace(/\|/g, '｜').replace(/\n/g, ' ');
const sec = (ms) => (ms == null ? '—' : `${(ms / 1000).toFixed(1)} 秒`);
const checked = replies.map((rs, i) => rs.map((r) => checkReply(r.text, cases[i].expect)));
const sums = variants.map((_, vi) => summarize(checked.map((cs) => cs[vi])));
const avgMs = variants.map((_, vi) => {
  const ms = replies.map((rs) => rs[vi].ms).filter((x) => x != null);
  return ms.length ? ms.reduce((a, b) => a + b, 0) / ms.length : null;
});
const avgFirst = variants.map((_, vi) => {
  const ms = replies.map((rs) => rs[vi].firstMs).filter((x) => x != null);
  return ms.length ? ms.reduce((a, b) => a + b, 0) / ms.length : null;
});
const avgLen = variants.map((_, vi) => replies.reduce((a, rs) => a + [...rs[vi].text].length, 0) / cases.length);

let md = `# プロンプト評価 ${new Date().toLocaleString('ja-JP')}\n\n${experiment.description ?? ''}\n\n`;
md += `- ケース: ${cases.length}（入力はテキストのみ。画面は見せていない）\n- 今日の配信: ${stream.title}\n`;
for (const v of variants) md += `- ${v.name}: persona=${v.persona} / model=${v.model}${v.thinkingLevel ? ` / thinking=${v.thinkingLevel}` : ''}\n`;
md += `\n## 集計（該当した返事の数 / ${cases.length}）\n\n| 項目 | ${variants.map((v) => v.name).join(' | ')} |\n|---|${variants.map(() => '---').join('|')}|\n`;
md += `| 平均の最初の文字までの時間 | ${avgFirst.map(sec).join(' | ')} |\n`;
md += `| 平均の返事が終わるまでの時間 | ${avgMs.map(sec).join(' | ')} |\n`;
md += `| 平均の文字数 | ${avgLen.map((n) => n.toFixed(0)).join(' | ')} |\n`;
md += `| **正解（黙る／話す）と一致** | ${sums.map((s) => `**${s.expectMatched} / ${s.expectTotal}**`).join(' | ')} |\n`;
for (const c of CHECKS) md += `| ${c.label} | ${sums.map((s) => s[c.key]).join(' | ')} |\n`;
md += `\n## ケースごとの返事\n\n| ケース | 入力 | ${variants.map((v) => v.name).join(' | ')} |\n|---|---|${variants.map(() => '---').join('|')}|\n`;
cases.forEach((c, i) => {
  const input = (c.type === 'idle' ? `（沈黙時の合図: 切り口 ${c.topic}）` : c.text) + `<br>正解: ${c.expect === 'silent' ? '黙る' : c.expect === 'speak' ? '話す' : 'どちらでも'}`;
  const mark = (ok) => (ok === null ? '' : ok ? '✓ ' : '✗ ');
  const cells = replies[i].map((r, vi) => `${mark(checked[i][vi].expectOk)}${esc(r.text)}<br>⚑ ${flags(checked[i][vi])}（最初の文字 ${sec(r.firstMs)}）${r.error ? `<br>失敗: ${r.error}` : ''}`);
  md += `| **${c.id}**<br>${c.note} | ${esc(input)} | ${cells.join(' | ')} |\n`;
});

fs.mkdirSync('eval/results', { recursive: true });
const file = path.join('eval/results', `${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.md`);
fs.writeFileSync(file, md);
console.log(`書き出しました: ${file}`);
for (const [vi, v] of variants.entries()) {
  console.log(`${v.name}: 正解一致 ${sums[vi].expectMatched}/${sums[vi].expectTotal}、最初の文字 ${sec(avgFirst[vi])}、終わり ${sec(avgMs[vi])}、${avgLen[vi].toFixed(0)} 字 / ${CHECKS.map((c) => `${c.label} ${sums[vi][c.key]}`).join(' / ')}`);
}
