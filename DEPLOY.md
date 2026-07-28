# デプロイ手順（Render 無料プラン + Supabase）

gitコマンドは使わず、すべてブラウザ操作だけで完結する手順です。月額0円（Render無料プラン＋Supabase無料枠）。

データはSupabase（外部の無料データベース）に保存するため、Renderのサーバーが15分アクセスなしでスリープしても登録済みスタッフの通知データは消えません。ただしスリープ後の初回アクセスは復帰に約1分かかります。

## 1. Supabaseでデータベースを用意する

1. https://supabase.com にアクセスし、アカウント作成（GitHubアカウントでのサインアップが早い）
2. 「New project」でプロジェクトを作成（名前は任意、パスワードは自動生成のままでOK、リージョンは`Northeast Asia (Tokyo)`など近いものを選択）
3. プロジェクトが立ち上がったら、左メニューの「SQL Editor」→「New query」を開く
4. このリポジトリの `supabase/setup.sql` の中身を全部貼り付けて「Run」をクリック（`stores`・`subscriptions`・`shifts`・`app_config`の4テーブルが作成される）
5. 左メニューの「Project Settings」（歯車アイコン）→「API」を開く
   - 「Project URL」をコピー → これが後で使う `SUPABASE_URL`
   - 「Project API keys」の中の **`service_role`**（`anon`ではない方）をコピー → これが `SUPABASE_SERVICE_KEY`
   - `service_role`キーは強い権限を持つ秘密鍵なので、他人に見せたりフロントエンドのコードに書いたりしないこと

## 2. GitHubにリポジトリを作る

1. https://github.com にアクセスし、アカウントがなければ新規登録
2. 右上の「+」→「New repository」
3. Repository name に `shift-help-notify-app` などと入力
4. Public / Private はどちらでも可（Private推奨）
5. 「Create repository」をクリック（README等は追加しなくてOK）
6. 作成後に出る空リポジトリの画面にある「uploading an existing file」リンクをクリック
7. `help-notify-app` フォルダの中身（`server.js`、`package.json`、`public/`フォルダごと、`supabase/`フォルダごと、`render.yaml`、`README.md`、`.gitignore`、`.env.example`）をまとめてドラッグ＆ドロップ
   - `.env`（もし手元で作っていれば）は上げない
8. 下部の「Commit changes」をクリック

## 3. Renderでアカウント作成

1. https://render.com にアクセスし、「Get Started」からアカウント作成（GitHubアカウントでのサインアップが一番早い）
2. サインアップ時にGitHubとの連携を許可すると、次のBlueprint検出がスムーズ

## 4. Blueprintでデプロイ

1. Renderダッシュボードで「New +」→「Blueprint」を選択
2. 先ほど作成したGitHubリポジトリを選択（連携直後は一覧に出ない場合、「Configure account」から対象リポジトリへのアクセスを許可）
3. リポジトリ内の `render.yaml` を自動検出するので、内容を確認
   - `VAPID_CONTACT_EMAIL`：連絡先メールアドレスを入力（実際に受信できるアドレスでなくても動作する）
   - `SUPABASE_URL`：手順1でコピーしたProject URL
   - `SUPABASE_SERVICE_KEY`：手順1でコピーしたservice_roleキー
   - 店舗名や管理者キーの入力欄はない（デプロイ後、店長が`/signup.html`から自分で店舗を作成する）
4. 「Apply」でデプロイ開始。初回ビルドは数分かかる
5. デプロイ完了後、サービスのURL（`https://shift-help-notify-app-xxxx.onrender.com`のような形式）が発行される

## 5. 動作確認

1. 発行されたURLの末尾に`/signup.html`を付けて開き（例：`https://.../signup.html`）、店舗名を入力して「登録する」
2. 表示された「管理者キー」をコピーしてメモしておく（この画面を閉じると二度と表示されない）
3. 同じ画面の「スタッフ登録用リンク」をスマホで開き（QRコードを読み取ってもよい）、お名前を入力して通知を許可・登録
4. `/manager.html` を開く。管理者キーを聞かれるので、手順2で控えたキーを入力。画面上部に自分の店舗名が表示されれば認証成功
5. 日付・時間を入れて「自分の店舗のスタッフに通知を送る」→ 手順3の端末に通知が届くか確認
6. 通知をタップ →応募画面→「このヘルプに入る」→ `manager.html`の募集状況に反映されるか確認
7. Supabaseダッシュボードの「Table Editor」で`stores`・`subscriptions`・`shifts`テーブルにデータが入っていることも確認できる（Excel感覚で中身を目視・編集できる）

## 6. 今後コードを更新する時

GitHubのリポジトリ画面で該当ファイルを開き「Edit」（鉛筆アイコン）→編集→Commit、で更新できます。RenderはGitHubリポジトリの変更を検知して自動的に再デプロイします。まとまった変更が増えてきたら、GitHub Desktop（GUIアプリ、gitコマンド不要）の導入がおすすめです。

## 7. 既に公開済みのアプリを「店長の自己登録方式」に切り替える場合

⚠️ この移行は既存の`subscriptions`・`shifts`テーブルを作り直すため、それまでに登録されていたデータ（スタッフの通知宛先・募集履歴）は消える。本番の実利用者がまだいない段階での移行を想定した手順。

1. Supabaseダッシュボード →「SQL Editor」で `supabase/migration_003_multi_tenant.sql` の中身を実行（`stores`テーブルの新設、`subscriptions`・`shifts`の作り直し）
2. Renderダッシュボード → 該当サービス →「Environment」タブを開き、古い`STORE_NAMES`・`ADMIN_KEYS`（または`ADMIN_KEY`）があれば削除する（もう使わない）
3. `server.js`・`public/index.html`・`public/manager.html`・`public/respond.html`をGitHub上で最新版に更新し、新しく`public/signup.html`を追加（GitHub Desktopまたはブラウザの直接編集）
4. Renderが自動で再デプロイする（または「Manual Deploy」→「Deploy latest commit」で手動実行）
5. 再デプロイ後、`/signup.html`から店舗を作り直してもらう（店舗ごとに新しい管理者キーとスタッフ登録用リンク/QRコードが発行される）
6. 店長には新しい管理者キーを、スタッフには新しい登録用リンク/QRコードを個別に配り直してもらう（古いURLの`/`はスタッフ登録に使えなくなるため、`/signup.html`で発行された`?store=店舗ID`付きのリンクに差し替える）

## 8. スリープを防ぐ（UptimeRobotで無料のまま常時起動に近づける）

Render無料プランは15分アクセスがないと自動スリープし、復帰に最大1分ほどかかります。外形監視サービスで数分おきにアクセスさせておくと、スリープする前に毎回リセットされるため、実質いつでもすぐ通知が飛ぶ状態を保てます。

1. https://uptimerobot.com でアカウント作成（無料、クレジットカード不要）
2. 「+ Add New Monitor」
   - Monitor Type：`HTTP(s)`
   - Friendly Name：任意（例：`shift-help-notify-app`）
   - URL：`https://（Renderで発行されたURL）/health`
   - Monitoring Interval：5分（無料プランの最短間隔）
3. 保存すればすぐに監視開始。数分後、Renderのダッシュボードでアクセスログが増えていれば正常

**注意点**

- Renderの無料プランは月750時間（≒31.25日分）まで。1サービスを常時起動させ続けるとこの上限ギリギリまで使うため、他にも無料プランのRenderサービスを動かしていると合算で上限に達し、月の途中ですべて一時停止することがある。このアプリ単体だけを常時稼働させる分には収まる計算だが、他のRenderプロジェクトと併用する場合は要注意
- これはRenderが公式にサポートしている方法ではなく、あくまで外部サービスを使った回避策。将来的に仕様変更で効かなくなる可能性はゼロではない
- `/health`はDBに触らず即座に200を返すだけのエンドポイントなので、Supabase側の無料枠消費には影響しない
- 根本的に気にしたくない場合は、`render.yaml`の`plan`を`starter`（月$7）に変更すればスリープ自体をなくせる（この場合UptimeRobotは不要）
