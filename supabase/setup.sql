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
--
-- 【低-1是正（独立再監査SECURITY_REVIEW_L5_FINAL.md）】比較を厳密不等号(a.created_at < b.created_at)
-- のみで行うと、created_at（トランザクション開始時刻。マイクロ秒精度）が完全同値になった
-- 重複行（是正前のレース条件下で同一マイクロ秒に開始した同時到着リクエストが原因）を
-- 1件も削除できない。ctidをタイブレーカに加え、同値でも必ず1件だけ残るようにする。
--
-- 適用前に、残存する重複が実際にあるか目視確認しておくことを推奨する（0件なら以下は無害）：
--   select email, count(*) from pending_signups group by email having count(*) > 1;
delete from pending_signups a using pending_signups b
  where a.email = b.email
    and (a.created_at, a.ctid) < (b.created_at, b.ctid);
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
--
-- 【中-A是正（独立再監査SECURITY_REVIEW_L5_FINAL.md）】上記の「枠の消費」は原子的だったが、
-- 「照合が成功した場合にpending行を無効化する」処理はSQL側に無く、アプリ側で店舗作成が
-- 終わったあとの別の往復（旧実装）だった。そのため「枠の消費」と「コードの使い切り」が
-- 別々の操作になっており、正しいコードを試行枠の範囲内（例:5本）で同時に投げると、
-- 全リクエストが照合に成功してしまい、無料期間つきの店舗を複数作成できてしまっていた
-- （stores.emailに一意制約が無く、resolveSkipFreeTrialがINSERTより前にSELECTするため）。
-- これはL-5の対策が守ろうとしていた「無料期間の使い回し防止」そのものの回避経路だった。
--
-- 対策として、ハッシュ照合そのものをこの関数（SQL側）に移し、
-- 「枠を消費する→照合する→一致すれば同じ関数内でDELETEする」までを1回の呼び出しに
-- まとめた。これにより「コードの使い切り」が構造的に1回だけになる：同時に何本投げても、
-- 行を削除できる（＝matched=trueを返せる）のは高々1回だけである（AC-L5-16・AC-L5-23）。
-- 戻り値からcode_hash（確認コードのハッシュ）を外したのも今回の変更点で、万一DB権限設定に
-- 漏れがあってもハッシュ自体は漏れなくなる（低-3への多層防御。AC-L5-17）。
-- シグネチャが変わる（p_code_hash引数の追加、戻り値の変更）ため、旧シグネチャの関数は
-- 明示的にdropする（同名でも引数の型/個数が違う関数はPostgreSQL上は別関数として残り続け、
-- 呼び出されないだけの死んだ関数・権限設定として残ってしまうため）。
drop function if exists consume_signup_attempt(text, int);

create or replace function consume_signup_attempt(p_email text, p_max int, p_code_hash text)
returns table (id uuid, name text, matched boolean)
language plpgsql
as $$
declare
  v_id uuid;
  v_name text;
  v_hash text;
  v_diff int := 0;
  v_i int;
begin
  -- 枠を原子的に1つ消費する（従来どおり。ここが並行数に依存しない上限の担保）。
  update pending_signups p
     set attempts = p.attempts + 1
   where p.email = p_email
     and p.attempts < p_max
     and p.expires_at > now()
  returning p.id, p.name, p.code_hash into v_id, v_name, v_hash;

  if not found then
    -- 該当なし／期限切れ／上限到達。0行を返す（呼び出し側lib/signup.jsはfail-closedで扱う）。
    return;
  end if;

  -- 照合はSQL側で行う。code_hashは固定長（SHA-256の16進数=64文字）のため、
  -- 途中で早期リターンせず全文字を必ず走査するXOR蓄積によって判定し、
  -- 不一致箇所の位置に応じた応答時間の差（タイミングオラクル）が生じない構造にする
  -- （定数時間比較）。
  if v_hash is null or p_code_hash is null or length(v_hash) <> length(p_code_hash) then
    return query select v_id, v_name, false;
    return;
  end if;

  for v_i in 1..length(v_hash) loop
    v_diff := v_diff | (ascii(substr(v_hash, v_i, 1)) # ascii(substr(p_code_hash, v_i, 1)));
  end loop;

  if v_diff <> 0 then
    return query select v_id, v_name, false;
    return;
  end if;

  -- 【中-A是正の核心】一致した場合は、同じ関数呼び出しの中でpending行を削除する。
  -- これにより、コードは構造的に1回しか使い切れなくなる。
  -- DELETEが0行だった場合、既に他の並行リクエストがこの行を消費していたことを意味する
  -- （直前のUPDATEで取得した行ロックがこの関数の呼び出し内で保持され続けるため、通常は
  -- 発生しないはずだが、念のためfail-closedにしておく）。
  -- 【L-5是正(独立再監査 中-1対応)】RETURNS TABLE (id uuid, ...) のidはPL/pgSQLの
  -- OUTパラメータ＝変数として宣言される。pending_signupsにも同名のid列があるため、
  -- 修飾せずに書くと「変数か列か曖昧」として実行時エラー(42702 column reference "id" is
  -- ambiguous)になる。plpgsql.variable_conflictの既定はerrorであり、かつこのエラーは
  -- CREATE FUNCTION時ではなく、この行に初めて到達したとき（＝利用者が正しい確認コードを
  -- 入力した瞬間）にしか検出されない。暗黙のルール（#variable_conflict use_column）に
  -- 頼らず、テーブルに別名pを付けて明示的に列を修飾することで曖昧さを解消する。
  delete from pending_signups p where p.id = v_id;
  if not found then
    return query select v_id, v_name, false;
    return;
  end if;

  return query select v_id, v_name, true;
end;
$$;

-- 【重要・計画担当レビュー指摘】PostgreSQLはCREATE FUNCTION時にEXECUTE権限を
-- PUBLICへ自動的に付与する。Supabase環境ではPostgREST経由でanon/authenticated
-- ロールからもRPCとして直接呼び出せるため、明示的にrevokeしない限り、
-- アプリのサーバー（service_roleキー）を経由せず誰でもこの関数を実行できてしまう。
-- p_maxは呼び出し側が自由に指定できる引数のため、anonから呼べると
-- p_max=999999を渡すだけでサーバー側の試行回数制限が無効化できてしまう
-- （戻り値からcode_hashを外した今回の変更後も、この権限設定自体は引き続き必須）。
-- なお本関数は意図的に security definer にしていない（呼び出し元をservice_roleに
-- 限定する設計のため、権限を不必要に広げるsecurity definerは不要）。
-- 【重要】このGRANT/REVOKEはCREATE FUNCTIONに追随して自動実行されません。
-- Supabase の SQL Editor で、この関数の再作成のたびに必ず手動実行してください
-- （AC-L5-12・AC-L5-13・AC-L5-18）。新シグネチャ(text, int, text)に対して設定する。
revoke all on function consume_signup_attempt(text, int, text) from public, anon, authenticated;
grant execute on function consume_signup_attempt(text, int, text) to service_role;

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

-- 【重要・計画担当レビュー指摘】consume_signup_attemptと同じ理由で、この関数も
-- CREATE FUNCTION時にEXECUTE権限がPUBLICへ自動付与されるため、anon/authenticatedから
-- rate limitやクールダウンを迂回して直接呼び出せてしまう可能性がある。
-- 本関数は意図的に security definer にしていない（service_role限定でアクセスする設計）。
-- 【重要】このGRANT/REVOKEはCREATE FUNCTIONに追随して自動実行されません。
-- Supabase の SQL Editor で、この関数の再作成のたびに必ず手動実行してください
-- （AC-L5-12・AC-L5-13）。
revoke all on function request_signup_code(text, text, text, timestamptz, int) from public, anon, authenticated;
grant execute on function request_signup_code(text, text, text, timestamptz, int) to service_role;

-- このアプリはサーバー（service_roleキー）からのみアクセスする設計のため、
-- RLS（Row Level Security）は有効化していません（新規テーブルはデフォルトで無効）。
-- service_roleキーは絶対にフロントエンド（public/配下のファイル）に埋め込まないでください。

-- ============================================================================
-- 【低-3是正（独立再監査SECURITY_REVIEW_L5_FINAL.md）】anonからのテーブル直アクセスを封じる。
-- 【重要】このブロックは自動で反映されません。本番でも Supabase の SQL Editor で
-- 必ず手動実行してください。
-- ============================================================================
-- RLSを有効化していない（上記コメント参照）ため、Supabaseの既定挙動（publicスキーマの
-- テーブルはanon/authenticatedにSELECT/INSERT/UPDATE/DELETE権限が既定で付与される）が
-- そのまま残っている場合、anonキーだけでData API経由にstores.admin_key_hashを直接
-- 書き換えられ、requireAdmin（server.js）の照合をすり抜けてオーナー権限そのものを
-- 奪取できてしまう。監査人はこのリポジトリ内外にanonキー・project refが公開されておらず
-- 外部から到達できる経路を確認できなかったため【低】判定としているが、
-- 「anonキーが漏れた場合は【高】相当になる」性質の指摘であるため、多層防御として
-- Data APIから完全に切り離しておく。
--
-- この一覧は本ファイルに定義されている全テーブル（stores, supervisor_keys,
-- pending_signups, subscriptions, shifts, app_config, stripe_events, used_emails,
-- reports）を網羅している。新しいテーブルを追加した場合は、ここにも追記すること。
revoke all on table stores, pending_signups, supervisor_keys, subscriptions,
                    shifts, app_config, stripe_events, used_emails, reports
  from anon, authenticated;
-- 将来追加されるテーブルにも、既定でanon/authenticatedへ権限が付与されないようにする
-- （低-2で指摘された「関数のEXECUTE権限が再作成のたびに手動運用に依存する」のと同種の
-- 問題を、テーブル権限側でも恒久化しておく）。
alter default privileges for role postgres in schema public
  revoke all on tables from anon, authenticated;
-- 【2026-08-09 実機確認の結果】上のalter文は意図どおり効いている。
-- staging で pg_default_acl を確認したところ、postgres の行から anon / authenticated が
-- 消え、postgres と service_role だけが残る状態になっていた。
--
-- ただし Supabase は既定権限を postgres と supabase_admin の「2つの役割」で設定しており、
-- supabase_admin の行には anon が残る。これは以下の理由で対処不要かつ対処不能である。
--   ・既定権限は「テーブルを誰が作ったか」で決まる。SQL Editor で作れば作成者は postgres
--     となるため、上のalter文が適用され anon には権限が付かない
--   ・supabase_admin は Supabase 内部専用の役割で、利用者がテーブルを作る際には使われない
--   ・supabase_admin の既定権限は権限不足で変更できない（permission denied）
--
-- したがって、新しいテーブルを追加するときの守りは「上の revoke all on table の一覧に
-- テーブル名を追記すること」である。これを忘れると、そのテーブルだけ anon から
-- 読める状態になり得る。scripts/verify-staging-summary.sql の確認5で検出できる。

-- 【低-5是正／2026-08-09】関数（RPC）についても、既定でanon/authenticatedへ
-- 実行権限が付与されないようにする。
--
-- 【なぜ必要か】PostgreSQL は CREATE FUNCTION 時に EXECUTE 権限を PUBLIC へ自動付与する。
-- Supabase では PostgREST 経由で anon から RPC を呼べるため、対策しないと
-- 「新しく作った関数が、誰でも直接呼べる」状態になる。
-- 実際に consume_signup_attempt がこの状態で、戻り値に code_hash を含んでいたため、
-- anon キーからハッシュを取得して6桁コードをオフライン総当たりできる経路が存在した
-- （2026-08-09 に計画担当が発見。上の revoke all on function で個別に塞いだ）。
--
-- 個別の revoke は「新しい関数を作るたびに追記する」手作業に依存しており、
-- 忘れれば同じ穴が再発する。この alter 文はその再発を構造的に防ぐ。
-- 以後、anon から呼ばせたい関数がある場合のみ、明示的に grant すること
-- （暗黙に許可されるのではなく、明示的に許可する形にするのが目的）。
--
-- 既存の関数には影響しない（既定権限は「これから作られるもの」にのみ適用される）。
alter default privileges for role postgres in schema public
  revoke all on functions from anon, authenticated;
