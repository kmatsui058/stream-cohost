// 評価用: ケースから、本番の答える役と同じ形の問い合わせ（指示・記録・召喚のきっかけ・方針・締めの文）を組み立てる。
import { formatSummonNote } from '../src/director.js';

// 2026-11-05 までの締めの文（返事を促していた）。新旧を比べるときだけ使う
export const OLD_CLOSING = '上の記録の最後までを踏まえて、相方として返事をしてください。';

// v: 条件（instruction = persona + 今日の配信、policies / summonNote を使うか、closing: 'old' で以前の締めの文）
// c: ケース（context = 直前の記録の行、text = 最後の発言、type = 'chat' ならチャット、policies = 方針の一覧、summon = 召喚のきっかけ）
export function buildResponderRequest(v, c) {
  const policies = v.policies && c.policies?.length
    ? `\n\n# マスターの方針（いつも守ること）\n${c.policies.map((p) => `- ${p}`).join('\n')}`
    : '';
  const last = c.type === 'chat' ? `チャット: ${c.text}` : `配信者: ${c.text}`;
  return {
    instruction: v.instruction + policies,
    transcript: [...(c.context ?? []), last].join('\n'),
    frames: [],
    ...(v.summonNote && c.summon && { summonNote: formatSummonNote(c.summon) }),
    ...(v.closing === 'old' && { closing: OLD_CLOSING }),
  };
}
