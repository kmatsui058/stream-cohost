// 評価用: 相方の返事をルールでチェックする。
// ここにある言い回しの一覧は、プロンプトに入れるものではなく、評価で検出するためのもの。
import { isSilentReply } from '../src/director.js';

export const CHECKS = [
  { key: 'empty', label: '返事なし', test: (t) => !t.trim() },
  { key: 'silent', label: '黙った（スルー）', test: (t) => isSilentReply(t) },
  { key: 'long', label: '120字超', test: (t) => [...t].length > 120 },
  { key: 'question', label: '疑問で終わる', test: (t) => /[?？]$|か。?$/.test(t.trim()) },
  { key: 'desuNe', label: '「ですね」', test: (t) => /ですね/.test(t) },
  {
    key: 'support',
    label: 'サポート口調',
    test: (t) => /了解|承知|準備は|確認して|お手伝い|見守|お任せ|いかがですか|しましょう|先決/.test(t),
  },
  {
    key: 'empathy',
    label: '共感の定型句',
    test: (t) => /素敵|楽しみ|わかります|分かります|大変でした|胸に響|さすが|おっしゃる通り|ご指摘の通り/.test(t),
  },
  { key: 'selfRef', label: '自分の役割に言及', test: (t) => /言葉の番人|言葉を司る/.test(t) },
  { key: 'wrongName', label: '呼び方の誤り', test: (t) => /小波|さざなみ|おこは|夕暮/.test(t) },
];

export const isSilent = (text) => isSilentReply(text ?? '');

// 正解（silent: 黙るべき / speak: 話すべき）と合っているか。正解が無ければ null
export function matchesExpect(text, expect) {
  if (expect === undefined) return null;
  return isSilent(text) === (expect === 'silent');
}

export function checkReply(text, expect) {
  const r = Object.fromEntries(CHECKS.map((c) => [c.key, c.test(text ?? '')]));
  r.expectOk = matchesExpect(text, expect);
  return r;
}

// 項目ごとに、該当した返事の数を数える。正解との一致は、照合したケースの中で数える
export function summarize(results) {
  const s = { total: results.length };
  for (const c of CHECKS) s[c.key] = results.filter((r) => r[c.key]).length;
  s.expectTotal = results.filter((r) => r.expectOk !== null && r.expectOk !== undefined).length;
  s.expectMatched = results.filter((r) => r.expectOk === true).length;
  return s;
}
