// 評価用: 相方の返事をルールでチェックする。
// ここにある言い回しの一覧は、プロンプトに入れるものではなく、評価で検出するためのもの。

export const CHECKS = [
  { key: 'empty', label: '返事なし', test: (t) => !t.trim() },
  { key: 'long', label: '70字超', test: (t) => [...t].length > 70 },
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

export function checkReply(text) {
  return Object.fromEntries(CHECKS.map((c) => [c.key, c.test(text ?? '')]));
}

// 項目ごとに、該当した返事の数を数える
export function summarize(results) {
  const s = { total: results.length };
  for (const c of CHECKS) s[c.key] = results.filter((r) => r[c.key]).length;
  return s;
}
