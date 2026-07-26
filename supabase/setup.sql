-- Supabaseの SQL Editor にこのまま貼り付けて実行してください。
-- （Dashboard左メニュー「SQL Editor」→「New query」→ 貼り付け →「Run」）

-- スタッフの通知宛先（Push Subscription）
create table if not exists subscriptions (
  id uuid primary key default gen_random_uuid(),
  endpoint text unique not null,
  subscription jsonb not null,
  registered_at timestamptz not null default now()
);

-- 急募（シフト応援）の履歴と状態
create table if not exists shifts (
  id uuid primary key default gen_random_uuid(),
  store_name text not null,
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

-- このアプリはサーバー（service_roleキー）からのみアクセスする設計のため、
-- RLS（Row Level Security）は有効化していません（新規テーブルはデフォルトで無効）。
-- service_roleキーは絶対にフロントエンド（public/配下のファイル）に埋め込まないでください。
