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
  current_period_end timestamptz
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

-- このアプリはサーバー（service_roleキー）からのみアクセスする設計のため、
-- RLS（Row Level Security）は有効化していません（新規テーブルはデフォルトで無効）。
-- service_roleキーは絶対にフロントエンド（public/配下のファイル）に埋め込まないでください。
