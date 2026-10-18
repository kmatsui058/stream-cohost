# Proposal

## Why

配信用 AI 相方（stream-cohost）は、仕様・自動テスト・CI がないまま約 1,000 行が書かれた。外部 API との結合部分は一度も検証されておらず、配信中のトラブルに即応できる品質の裏付けがない。そこで、今の振る舞いを仕様として固定し、テストと CI で守れる状態にする。

## What Changes

- 現在の振る舞いを、能力（capability）ごとの仕様として明文化する。未コミットだった「会話の要約による記憶の引き継ぎ」も対象に含める。
- 仕様の各シナリオに対応する自動テストを追加する。外部サービス（Gemini、VOICEVOX、OBS、YouTube、ffmpeg）は差し替え可能にし、CI ではネットワークや実機なしで動くようにする。
- テストを書けるようにするための最小限のリファクタリングを行う（外部依存の注入）。外から見た振る舞いは変えない。
- 仕様化やテストで見つかった不具合を修正する。
- GitHub Actions で CI（テスト、カバレッジ閾値、`openspec validate --strict`）を回す。
- 実機・実 API を使う手動スモークテストの手順を用意する（Gemini API キーなどは正規に設定してから実施する）。
- 即席の検証スクリプト（`scripts/test-*.js`）は正式なテストに置き換えて削除する。

## Capabilities

### New Capabilities

- `audio-input`: 配信者のマイク音声を取り込み、AI に連続して届ける
- `screen-capture`: 視聴者が見ている配信画面を定期的に取り込み、AI に届ける
- `live-session`: AI とのリアルタイムセッションの確立・維持・張り直し・コンテキスト上限
- `conversation-memory`: 会話の書き起こしを要約し、セッションをまたいで文脈を引き継ぐ
- `turn-taking`: AI の発言の区切り方と、割り込み・沈黙・チャット注入のタイミングを決める
- `speech-output`: AI の発言を音声合成し、順番どおりに再生させ、中断できるようにする
- `stream-overlay`: 配信ソフトに重ねる画面で、音声を再生し、字幕と口パクを表示する
- `live-chat`: YouTube ライブチャットの新着コメントを取得する
- `operator-controls`: 配信者がコンソールから相方を一時停止・スキップ・張り直しなどできる

### Modified Capabilities

（なし。既存の仕様はない）

## Impact

- 変更するコード：`src/` の全モジュール（外部依存の注入のため）、`public/overlay.html`（テスト可能な形に分離する場合）
- 追加するもの：`test/`、`vitest.config.js`、`.github/workflows/ci.yml`、開発依存の `@vitest/coverage-v8`
- 削除するもの：`scripts/test-voice.js`、`scripts/test-memory.js`
- 実行時の依存と外部 API の使い方は変えない
