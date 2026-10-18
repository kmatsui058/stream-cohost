// API を呼ばずに Memory の畳み込みとプロンプト組み立てを確認する（要約モデルは偽物）。
// 実行: npm run test:memory
import assert from 'node:assert/strict';
import { Memory } from '../src/memory.js';

let lastPrompt = '';
const fakeAi = {
  models: {
    generateContent: async ({ contents }) => {
      lastPrompt = contents;
      return { text: '- ゲーム実況中。ボス戦で3回負けた' };
    },
  },
};

const mem = new Memory({ ai: fakeAi, model: 'stub', maxChars: 1500, recentEntries: 2, persona: 'PERSONA' });
assert.equal(mem.instruction(), 'PERSONA');

// 細切れの文字起こしは同じ話者なら 1 件にまとまる
mem.add('配信者', 'ボス');
mem.add('配信者', '強すぎ');
mem.add('相方', 'もう');
mem.add('相方', '3回目だね。');
mem.add('チャット', 'Aさん: がんばれ');
mem.add('チャット', 'Bさん: 草');
assert.equal(mem.entries.length, 4);
assert.equal(mem.entries[0].text, 'ボス強すぎ');

await mem.summarize();
assert.match(lastPrompt, /配信者: ボス強すぎ/);
assert.doesNotMatch(lastPrompt, /Bさん/); // 直近 2 件は要約に回さない
assert.equal(mem.entries.length, 2);

const inst = mem.instruction();
assert.match(inst, /^PERSONA/);
assert.match(inst, /ボス戦で3回負けた/);
assert.match(inst, /チャット: Aさん: がんばれ\nチャット: Bさん: 草/);
console.log(inst);
console.log('\nOK');
