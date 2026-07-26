# 急な欠勤ヘルプ募集ボット

店長が「急な欠勤の穴埋め探し」にかけている時間をなくすための、LINEも個人情報も使わないPush通知アプリ。

## 構成

- `server.js` — Express + web-push のバックエンド
- `public/index.html` — スタッフ用：通知登録画面
- `public/manager.html` — 店長用：急募を配信＋募集状況の確認
- `public/respond.html` — スタッフ用：通知をタップした先の応募画面（先着1名）
- `public/sw.js` — Service Worker（プッシュ通知の受信・タップ処理）
- `supabase/setup.sql` — Supabase（外部の無料データベース）に作成するテーブルのDDL
- データ（スタッフの通知宛先、募集履歴、VAPID鍵）はSupabaseに保存する。Renderのサーバー自体は状態を持たない設計

## 元コードからの主な修正点

1. **データの永続化先をSupabase（外部DB）にした。** 元のコードはメモリ上の配列に保存しており、サーバー再起動のたびに全登録が消えるバグがあった。Render無料プランはローカルディスクも一時的なため、ファイル保存ではなく外部DBに保存する構成にした。
2. **VAPID鍵もSupabaseに保存し使い回す。** 元のコードは起動のたびに鍵を再生成しており、再起動するだけで登録済み全スタッフの通知が届かなくなるバグがあった。
3. **先着順の応募をDB側のUPDATE文で原子的に判定。** `UPDATE ... WHERE status = 'open'` を使うことで、複数人が同時にボタンを押しても1人しか成立しないことをPostgres側で保証している。
4. **`index.html`内の壊れた`fetch`URL・`server.js`内の壊れた`mailto`リンクを修正。**（コピペ時にMarkdownのリンク記法が混入していた）
5. **`sw.js`の`vibrate:,`を`vibrate: [200, 100, 200]`に修正。**（空の配列指定は構文エラーになる）
6. **公開鍵をハードコードせず`/api/vapid-public-key`から取得するように変更。**
7. **店長用ダッシュボード（`manager.html`）を新規作成。** 元のコードには配信ボタンを押すUIがなかった。
8. **応募画面（`respond.html`）を新規作成。** 通知タップ先として言及はあったが実体がなかった。
9. **店長用APIに簡易認証を追加。** `x-admin-key`ヘッダーで`.env`の`ADMIN_KEY`と照合。

## セットアップ

1. https://supabase.com でプロジェクトを作成し、SQL Editorで `supabase/setup.sql` を実行（テーブル作成）
2. Project Settings → API から `Project URL` と `service_role` キーを控える

```bash
cd help-notify-app
npm install
cp .env.example .env
# .envを開いて ADMIN_KEY・SUPABASE_URL・SUPABASE_SERVICE_KEY を設定する
npm start
```

起動時にコンソールへVAPID公開鍵が表示されるが、コピペ作業は不要（フロントが自動取得し、鍵自体もSupabaseに保存され使い回される）。

## ローカルでの動作確認

1. `http://localhost:3000/` をスマホ（またはPCのChrome）で開き、通知を許可して登録
2. `http://localhost:3000/manager.html` を別端末（店長のスマホ・PC）で開く。初回アクセス時に管理者キー（`.env`の`ADMIN_KEY`）を聞かれるので入力
3. 店舗名・日付・時間を入れて「全スタッフに通知を送る」
4. 手順1の端末に通知が届く → タップ → 応募画面が開く → 「このヘルプに入る」で応募
5. `manager.html`の「募集状況」で担当者が確定したことを確認

## 本番公開（Render 無料プラン + Supabase）

`DEPLOY.md` にgitコマンド不要のデプロイ手順（Supabaseのプロジェクト作成〜GitHubへのアップロード〜Renderへのデプロイ〜動作確認）をまとめてある。月額0円。`render.yaml` は無料プラン（`plan: free`）を前提にした設定済みのBlueprint。

## 本番公開時の注意点

- **HTTPS必須。** Push通知はHTTPS（またはlocalhost）でしか動かない。Renderにデプロイすれば自動でHTTPSが付く。
- **`APP_URL`は基本設定不要。** Render上で動かす場合、Renderが自動で用意する`RENDER_EXTERNAL_URL`をserver.jsが自動的に使う。別ドメインを使う場合のみ`.env`の`APP_URL`で上書きする。
- **iPhone（Safari）は「ホーム画面に追加」しないと通知許可ボタンが押せない。** スタッフへの案内は`index.html`に既に一言添えてあるが、QRコードを配る場合は「読み取ったら一度ホーム画面に追加してね」と口頭でも伝えるとよい。
- **Render無料プランは15分アクセスがないとスリープする。** データはSupabase側にあるため消えないが、スリープ復帰時は起動に最大1分ほどかかる。UptimeRobot等で`/health`エンドポイントを5分おきにpingしておくとスリープをほぼ回避できる（手順は`DEPLOY.md`参照、月750時間の無料枠内に収まる想定）。根本的に気にしないなら`render.yaml`の`plan`を`starter`（月$7）に変えるだけでもよい（コード変更は不要）。
- **`SUPABASE_SERVICE_KEY`は強い権限を持つ秘密鍵。** フロントエンド（`public/`配下）には絶対に書かず、サーバー側の環境変数としてのみ扱うこと。

## 今後の拡張候補

- 店長側の即時プッシュ配信結果通知（Slack/メールへのサマリ送信など）
- 「30分応答なしで外部求人サービスへの導線を表示」のような追加ボタン
- スタッフごとの得意エリア（レジ／惣菜など）タグ付けと絞り込み配信
