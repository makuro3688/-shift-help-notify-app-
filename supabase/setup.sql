-- Supabaseの SQL Editor にこのまま貼り付けて実行してください。
-- （Dashboard左メニュー「SQL Editor」→「New query」→ 貼り付け →「Run」）

-- 店舗（店長が自己登録すると1行増える）。店舗名は重複してもよい。
-- 別の店舗と区別しているのは店舗名ではなく、この id（自動採番）。
create table if not exists stores (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  admin_key_hash text not null unique, -- 管理者キーのSHA-256ハッシュ。生のキーはDBに保存しない
  created_at timestamptz not null default now(),
  -- 課金関連（trial=無料期間中 / active=有料プラン利用中 / past_due=支払い失敗 / canceled=解約済み）
  subscription_status text not null default 'trial',
  subscription_plan text, -- monthly | quarterly | yearly
  stripe_customer_id text,
  stripe_subscription_id text,
  current_period_end timestamptz,
  email text, -- 店舗登録時に確認したメールアドレス（無料期間の使い回し防止・連絡用）
  skip_free_trial boolean not null default false -- 同じメールで2店舗目以降を作った場合true。1か月間の無料配信し放題を与えない
);

-- 時間帯責任者用のサブ管理者キー。オーナー・店長が発行し、代理募集の配信のみ許可される
-- 限定権限。スタッフ管理・料金確認・契約更新・プラン変更・解約はできない。
create table if not exists supervisor_keys (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references stores(id) on delete cascade,
  admin_key_hash text not null unique, -- 管理者キーのSHA-256ハッシュ。生のキーはDBに保存しない
  label text, -- 「土曜夜担当」など、誰用のキーか分かるようにするための任意の名前
  created_at timestamptz not null default now()
);

-- 店舗登録時のメール認証用の一時テーブル。確認コードを送ってから店舗を作成するまでの間だけ使う。
-- 認証済みで店舗作成が完了したら該当行は削除する。expires_atを過ぎた行は無効。
create table if not exists pending_signups (
  id uuid primary key default gen_random_uuid(),
  email text not null,
  name text not null,
  code_hash text not null, -- 6桁確認コードのSHA-256ハッシュ。生のコードはDBに保存しない
  expires_at timestamptz not null,
  attempts integer not null default 0, -- L-5是正: 確認コードの検証に失敗した回数。SIGNUP_CODE_MAX_ATTEMPTS（server.js）に達すると失効させ、総当たり攻撃を防ぐ
  created_at timestamptz not null default now()
);

-- スタッフの通知宛先（Push Subscription）
create table if not exists subscriptions (
  id uuid primary key default gen_random_uuid(),
  endpoint text unique not null,
  subscription jsonb not null,
  store_id uuid not null references stores(id) on delete cascade,
  store_name text, -- storesテーブルの名前を複製したもの（表示用。実際の判定はstore_idで行う）
  staff_name text, -- 登録時に入力したお名前（あだ名可）。応募時になりすまし防止のチェックに使う
  registered_at timestamptz not null default now()
);

-- 急募（シフト応援）の履歴と状態
create table if not exists shifts (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references stores(id) on delete cascade,
  store_name text not null, -- storesテーブルの名前を複製したもの（表示用）
  date text not null,
  time text not null,
  note text default '',
  status text not null default 'open', -- open | filled
  filled_by text,
  filled_at timestamptz,
  created_at timestamptz not null default now()
);

-- VAPID鍵など、サーバー起動時に自動生成・再利用する設定値
create table if not exists app_config (
  key text primary key,
  value text not null
);

-- Stripe Webhookから届くイベントを重複処理しないための記録テーブル
create table if not exists stripe_events (
  id text primary key, -- StripeのイベントID（evt_...）
  received_at timestamptz not null default now()
);

-- 退会（利用規約 第17条1項）した店舗のメールアドレスを記録し、無料期間の再取得を防ぐテーブル。
-- 退会するとstoresの行自体を物理削除するため、「過去に退会したか」を判定する手がかりが
-- 他に残らない。email は平文ではなく既存のhashKey()と同じSHA-256ハッシュのみを保存する。
create table if not exists used_emails (
  email_hash text primary key, -- メールアドレスのSHA-256ハッシュ。生のメールアドレスは保存しない
  created_at timestamptz not null default now()
);

-- 通報（利用規約 第13条）の受付内容を保存するテーブル。
-- スタッフは管理者キーを持たないため通報APIは認証なしで呼べる設計になっており、
-- store_idも自己申告のため、内部の外部キーとしては使うが「本人確認済みの店舗」ではない点に注意。
-- 店舗が退会（stores行の物理削除）した後も通報記録は調査・証跡のために残す必要があるため、
-- CASCADE（連動削除）ではなく SET NULL（店舗との紐付けだけを外す）にしている。
create table if not exists reports (
  id uuid primary key default gen_random_uuid(),
  store_id uuid references stores(id) on delete set null,
  reporter text, -- 通報者の任意の識別情報（あだ名等。匿名可のためNULL許容）
  target text not null, -- 通報対象
  content text not null, -- 通報内容
  -- 通報はなりすまし・虚偽申告が可能なため、運営が真偽を判断する材料として
  -- 受信時のIPアドレスとUser-Agentを証跡として記録する（プライバシーポリシー第2条11〜13項
  -- 「利用履歴、操作履歴およびアクセスログ」「IPアドレス」の取得、第3条8項「不正利用の防止
  -- およびセキュリティ対策のため」の利用目的に対応）。
  source_ip text,
  user_agent text,
  created_at timestamptz not null default now()
);

-- 既存環境（この列追加前に作成されたDB）向けのマイグレーション。
-- create table if not exists は既存テーブルには列を追加しないため、明示的にALTERする。
alter table reports add column if not exists source_ip text;
alter table reports add column if not exists user_agent text;

-- L-5是正: 確認コードの総当たり対策（試行回数の記録）。既存環境向けのマイグレーション。
alter table pending_signups add column if not exists attempts integer not null default 0;

-- このアプリはサーバー（service_roleキー）からのみアクセスする設計のため、
-- RLS（Row Level Security）は有効化していません（新規テーブルはデフォルトで無効）。
-- service_roleキーは絶対にフロントエンド（public/配下のファイル）に埋め込まないでください。
