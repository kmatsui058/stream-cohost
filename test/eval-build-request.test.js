import { describe, it, expect } from 'vitest';
import { buildResponderRequest, OLD_CLOSING } from '../eval/build-request.js';
import { formatSummonNote } from '../src/director.js';

describe('prompt-eval / 本番と同じ材料で評価する', () => {
  const c = {
    context: ['配信者: 精霊石が揃った'],
    text: 'いや、一旦これで戻って、ヴァール城かな、次。',
    policies: ['攻略は聞かれたときだけ答える'],
    summon: { from: '配信者の発言', text: 'いや、一旦これで戻って、ヴァール城かな、次。', word: 'ヴァール' },
  };

  it('聞き間違いの召喚のケース: 本番と同じ形で召喚のきっかけと方針を入れ、記録の最後に発言を置く', () => {
    const req = buildResponderRequest({ instruction: 'PERSONA', policies: true, summonNote: true }, c);
    expect(req.summonNote).toBe(formatSummonNote(c.summon));
    expect(req.summonNote).toContain('「ヴァール」に反応して召喚されました');
    expect(req.instruction).toBe('PERSONA\n\n# マスターの方針（いつも守ること）\n- 攻略は聞かれたときだけ答える');
    expect(req.transcript).toBe('配信者: 精霊石が揃った\n配信者: いや、一旦これで戻って、ヴァール城かな、次。');
    expect(req.closing).toBeUndefined();
  });

  it('以前の条件: 方針・召喚のきっかけを入れず、以前の締めの文を使う。チャットのケースはチャットとして置く', () => {
    const req = buildResponderRequest({ instruction: 'OLD', closing: 'old' }, { ...c, type: 'chat', text: '@A: オルダいる?' });
    expect(req.instruction).toBe('OLD');
    expect(req.summonNote).toBeUndefined();
    expect(req.closing).toBe(OLD_CLOSING);
    expect(req.transcript.split('\n').at(-1)).toBe('チャット: @A: オルダいる?');
  });
});
