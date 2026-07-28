-- 「店舗ごとの管理者キー」方式（店舗名の文字列一致で区別）から、
-- 「店長の自己登録」方式（自動採番される店舗IDで区別）へ切り替えるための移行SQL。
--
-- ⚠️ 注意：このSQLは既存の subscriptions・shifts テーブルを削除して作り直します。
-- 今入っているテスト用データ（牛久店・つくば店など）は消えます。
-- 本番の実利用者がまだいない前提のSQLです（実データがある場合は実行前に相談してください）。
--
-- Supabaseダッシュボード → SQL Editor → New query に貼り付けて「Run」してください。

drop table if exists subscriptions cascade;
drop table if exists shifts cascade;

create table stores (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  admin_key_hash text not null unique,
  created_at timestamptz not null default now()
);

create table subscriptions (
  id uuid primary key default gen_random_uuid(),
  endpoint text unique not null,
  subscription jsonb not null,
  store_id uuid not null references stores(id) on delete cascade,
  store_name text,
  staff_name text,
  registered_at timestamptz not null default now()
);

create table shifts (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references stores(id) on delete cascade,
  store_name text not null,
  date text not null,
  time text not null,
  note text default '',
  status text not null default 'open',
  filled_by text,
  filled_at timestamptz,
  created_at timestamptz not null default now()
);
