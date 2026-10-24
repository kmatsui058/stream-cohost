# stream-cohost

配信用 AI 相方（聞く: Gemini Live の文字起こし / 答える: Gemini 4 Argon / 声: VOICEVOX / 表示: OBS）。名前で召喚され、会話が終わると自分で退去する。仕組みは README.md、振る舞いの仕様は openspec/specs/ が正。

## 開発の進め方
- main に直接コミットしない。作業ごとにブランチ → PR → CI（Windows / Ubuntu。openspec validate --all --strict と vitest のカバレッジ 80%）が通ったら Claude がマージし、PR に変更点の要約を残す
- 振る舞いを変えるときは、先に OpenSpec の変更（proposal / specs / tasks）を作る。persona.md の文面だけの変更は OpenSpec 不要
- gh はこのリポジトリ限定の Fine-grained PAT。Checks 権限が無いので、CI の確認は gh pr checks ではなく gh run list / watch / view を使う

## 評価（npm run eval）
- 実際の Gemini を呼ぶので課金が発生する。実行前に必ず AskUserQuestion で確認する（2 条件 × 20 ケースで約 $0.2）
- 結果は加工せず、そのまま見せる
- PowerShell では npm run eval -- --experiment ... の -- が消えるので、node --env-file=.env eval/run.js --experiment ... を直接使う

## 外部サービスと素材
- Google Cloud（stream-cohost-h1n64o）は有料枠・前払いクレジット。クレジットが切れると Gemini の呼び出しがすべて止まる（1011 "prepayment credits are depleted"）
- 立ち絵（H1N4 の素材）とナースロボ＿タイプＴの公式立ち絵は再配布禁止。画像も、立ち絵が写ったスクリーンショットもコミットしない
- 配信者の呼び方は「マスター」（persona.md）

## 作業リスト
- 配信後の TODO は docs/backlog.md
