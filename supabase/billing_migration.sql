-- 課金機能を追加する際に、既存のSupabaseプロジェクトに対して1回だけ実行してください。
-- （Dashboard左メニュー「SQL Editor」→「New query」→ このファイルの中身を貼り付け →「Run」）
-- 新規にプロジェクトを作る場合は、先に setup.sql を実行してから、続けてこのファイルも実行してください
-- （setup.sqlは既にこの内容を含む最新版に更新済みです。両方実行しても create table if not exists /
--   add column if not exists なのでエラーにはなりません）。

alter table stores
  -- trial（無料期間中） | active（有料プラン利用中） | past_due（支払い失敗） | canceled（解約済み）
  add column if not exists subscription_status text not null default 'trial',
  -- monthly | quarterly | yearly（Stripeの価格と対応）
  add column if not exists subscription_plan text,
  add column if not exists stripe_customer_id text,
  add column if not exists stripe_subscription_id text,
  add column if not exists current_period_end timestamptz;

-- Stripe Webhookから届くイベントを重複処理しないためのテーブル（任意だが推奨）
create table if not exists stripe_events (
  id text primary key, -- StripeのイベントID（evt_...）
  received_at timestamptz not null default now()
);
