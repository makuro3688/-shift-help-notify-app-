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

-- ============================================================================
-- L-5是正(2周目): セキュリティ監査で「高」判定を受けたレース条件の是正。
-- 【重要】このブロックは自動で反映されません。Supabase の SQL Editor で手動実行してください。
-- 詳細な経緯・PoC実測値は SECURITY_REVIEW_L5.md（監査報告書）を参照。
-- ============================================================================

-- 【中-1是正の前提】request_signup_code のON CONFLICT対象として、pending_signups.email に
-- 一意インデックスが必要。追加前に、過去のレース条件（今回是正する高-1のバグそのもの）に
-- より本番環境に残っている可能性のある重複行（同一emailの複数pending行）を、
-- 最新の1件だけ残して削除しておく（一意インデックス作成が失敗しないための安全対策）。
delete from pending_signups a using pending_signups b
  where a.email = b.email and a.created_at < b.created_at;
create unique index if not exists pending_signups_email_key on pending_signups (email);

-- 【高-1是正】確認コードの試行枠を原子的に1つ消費する。
-- 旧実装（server.js）は「SELECTで現在値を読む→アプリ内で+1計算→UPDATEで絶対値を書き込む」
-- という非原子的なread-modify-writeで、SELECTとUPDATEの間（Supabaseへのawait区間）に
-- 他リクエストが割り込めた。PostgRESTの.update()は列相対更新(attempts = attempts + 1)を
-- 表現できないため、単一のSQL文で完結するこの関数(RPC)が必須（監査PoCで、楽観ロック(CAS)
-- では直らない＝照合が書き込みより前に完了するため効果が無いことも確認済み）。
-- UPDATE...WHERE...RETURNING は単一文なので行ロックが効き、同時実行でも
-- 「枠を取れるのは上限回数まで」が厳密に保証される。行が返らない(0行)＝
-- 「該当なし／期限切れ／上限到達」のいずれか（呼び出し側lib/signup.jsはこれを区別しない）。
create or replace function consume_signup_attempt(p_email text, p_max int)
returns table (id uuid, name text, code_hash text, expires_at timestamptz, attempts int)
language sql
as $$
  update pending_signups p
     set attempts = p.attempts + 1
   where p.id = (
           select id from pending_signups
            where email = p_email
            order by created_at desc
            limit 1
         )
     and p.attempts < p_max
     and p.expires_at > now()
  returning p.id, p.name, p.code_hash, p.expires_at, p.attempts;
$$;

-- 【中-1是正】確認コード再送の60秒クールダウンを原子的に判定する。
-- 旧実装は「直近送信をSELECT→アプリ内で60秒経過を判定→古い行をDELETE→新しい行をINSERT」
-- という複数文のread-modify-writeで、同時多発リクエストは全員がクールダウンをすり抜けられた
-- （監査PoC: 同時500件送信→429=0件、被害者に500通のメールが届くことを実証）。
-- 単一のINSERT...ON CONFLICT...DO UPDATE...WHERE文にまとめることで、
-- 「クールダウン確認・古いコードの無効化・新しいコードの発行」を不可分に行う。
create or replace function request_signup_code(
  p_email text,
  p_name text,
  p_code_hash text,
  p_expires_at timestamptz,
  p_cooldown_seconds int
) returns table (accepted boolean, retry_after_seconds int)
language plpgsql
as $$
declare
  v_row pending_signups%rowtype;
begin
  -- 新規メールなら素直にINSERTされる。既存メールの場合はON CONFLICTのDO UPDATEに入るが、
  -- WHERE句（直近作成からp_cooldown_seconds秒以上経過している）を満たさない限り更新されない。
  -- 更新されなければRETURNINGは何も返さず、FOUNDはfalseになる（＝クールダウン中）。
  insert into pending_signups as p (email, name, code_hash, expires_at, attempts)
  values (p_email, p_name, p_code_hash, p_expires_at, 0)
  on conflict (email) do update
    set name = excluded.name,
        code_hash = excluded.code_hash,
        expires_at = excluded.expires_at,
        attempts = 0,
        created_at = now()
    where p.created_at <= now() - (p_cooldown_seconds || ' seconds')::interval
  returning p.* into v_row;

  if found then
    return query select true, 0;
    return;
  end if;

  -- クールダウン中：既存行を読み、案内用に残り秒数を計算して返す（呼び出し側は現状未使用）。
  select * into v_row from pending_signups where email = p_email;
  return query
    select false, greatest(0, (p_cooldown_seconds - extract(epoch from (now() - v_row.created_at)))::int);
end;
$$;

-- このアプリはサーバー（service_roleキー）からのみアクセスする設計のため、
-- RLS（Row Level Security）は有効化していません（新規テーブルはデフォルトで無効）。
-- service_roleキーは絶対にフロントエンド（public/配下のファイル）に埋め込まないでください。
