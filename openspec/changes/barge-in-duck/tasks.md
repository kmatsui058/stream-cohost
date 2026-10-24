# Tasks

## 1. 声を小さくする

- [x] 1.1 `src/config.js`：`BARGE_IN`（duck/stop/off、既定 duck。1・true は stop、0・false は off）、`DUCK_VOLUME`、`DUCK_RELEASE_MS`。確認：設定のテストが通る
- [x] 1.2 `src/listener.js`：途中経過を伝える。確認：live-session のシナリオのテストが通る
- [x] 1.3 `src/speaker.js`：声を小さくする・戻す。確認：speech-output のシナリオのテストが通る
- [x] 1.4 `src/director.js`・`src/app.js`：設定に従って小さくする／止める／何もしない。確認：turn-taking のシナリオのテストが通る
- [x] 1.5 `public/overlay-core.js`：音量の指示で再生音量を変える。確認：stream-overlay のシナリオのテストが通る
- [x] 1.6 `.env.example`、README
- [ ] 1.7 マスターが実機で確かめる

## Workflow follow-up

- マージ後に、この変更をアーカイブする。
