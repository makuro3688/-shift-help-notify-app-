-- ============================================================================
-- scripts/verify-staging.sql
--
-- 【これは何か】
-- SECURITY_REVIEW_L5_FINAL2.md（第8部・本番反映前チェックリスト）のうち、
-- PostgREST（アプリのAPI）経由では確認できない pg_catalog / information_schema の
-- 項目を、Supabase の SQL Editor に直接貼り付けて実行するための確認用SQLです。
--
-- 【安全性】このファイルは SELECT のみで構成されています。
-- INSERT / UPDATE / DELETE / DDL（create / alter / drop 等）は一切含まれていません。
-- 何度実行してもデータやスキーマは変化しません（副作用ゼロ）。
--
-- 【実行方法】
-- 1. Supabase ダッシュボード → 対象プロジェクト（本番ではなく、検証用 daida-staging）
--    → SQL Editor を開く
-- 2. このファイルの中身を丸ごと貼り付けて「Run」を押す
-- 3. クエリごとに結果が表示されるので、各クエリの直前のコメントに書いた
--    「期待する結果」「結果の読み方」と見比べる
--
-- 【重要】このSQLは検証用（daida-staging）プロジェクトに対して実行してください。
-- 本番プロジェクトに対して実行しても（SELECTのみのため）データが壊れることはありませんが、
-- 本番の権限設定を確認する目的では使わないでください（本番と検証用でsetup.sqlの適用状態が
-- ずれている可能性があるため、確認する意味がありません）。
-- ============================================================================


-- ----------------------------------------------------------------------------
-- 確認1（チェックリスト #2）: pending_signups に同一メールの重複行が無いこと
-- ----------------------------------------------------------------------------
-- 【何を確認するのか】
-- request_signup_code RPC（supabase/setup.sql）は "on conflict (email) do update" で
-- 同じメールアドレスの行を1行に保つ設計です。もし何らかの理由で同じメールアドレスの行が
-- 2行以上存在していると、確認コードの照合(consume_signup_attempt)がどちらの行を見ているのか
-- 予測できなくなり、想定外の500エラーや、意図しない失効・成功が起こり得ます。
--
-- 【期待する結果】
-- 0件（1行も返らない）。
--
-- 【結果の読み方】
-- 実行結果が「0 rows」あるいは何も表示されなければ問題ありません。
-- もし emailと件数(count)の行が1行でも表示されたら、そのメールアドレスに重複行があるため、
-- 開発担当に連絡してください（削除方法は SECURITY_REVIEW_L5_FINAL2.md 低-6 を参照）。
select email, count(*)
from pending_signups
group by email
having count(*) > 1;


-- ----------------------------------------------------------------------------
-- 確認2（チェックリスト #12）: 両RPCの実行権限が service_role のみであること
-- ----------------------------------------------------------------------------
-- 【何を確認するのか】
-- 確認コードの照合(consume_signup_attempt)と発行(request_signup_code)は、
-- アプリのサーバー（service_roleキー）だけが呼べるべきで、利用者のブラウザが持つ
-- anonキーや、ログイン済みユーザーのauthenticatedロールから直接呼べてはいけません
-- （直接呼べると、レート制限やバリデーションを全部すっ飛ばして総当たりできてしまいます）。
--
-- 【期待する結果】
-- 2行返り、それぞれの proacl（権限一覧）の中身が "service_role=X/postgres" という
-- 1個の権限だけであること。
--
-- 【結果の読み方】
-- proacl 列に "service_role=X/postgres" 以外の文字列（例: "anon=X/postgres" や
-- "authenticated=X/postgres"）が含まれていたら異常です。anon/authenticatedにも
-- 実行権限が付いてしまっている（=誰でも直接RPCを呼べてしまう）ことを意味するため、
-- 至急 supabase/setup.sql の revoke/grant 文が適用されているか確認してください。
select
  p.proname,
  array_to_string(p.proacl, E'\n') as permissions
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname in ('consume_signup_attempt', 'request_signup_code');


-- ----------------------------------------------------------------------------
-- 確認3（チェックリスト #13）: anon / authenticated への「既定の権限付与」が
-- publicスキーマのテーブルに対して消えていること
-- ----------------------------------------------------------------------------
-- 【何を確認するのか】
-- Supabaseは既定で「publicスキーマに新しいテーブルを作ると、自動的にanon/authenticated
-- からも読み書きできるようになる」設定が入っています。supabase/setup.sql は
-- "alter default privileges for role postgres in schema public revoke all on tables
-- from anon, authenticated;" でこの既定動作を止めています。この確認は、その設定が
-- 実際に効いているかを見るものです。
--
-- 【期待する結果】
-- public スキーマ（下記のwhere句で絞り込み済み）の行の default_acl 列に、
-- "anon=" や "authenticated=" という文字列が（テーブル向けの権限として）含まれていないこと。
--
-- 【結果の読み方】
-- 行が0件でも問題ありません（＝その既定権限の上書き設定自体が無い＝Supabaseの生の既定値が
-- そのまま使われる状態です。ただしその場合は setup.sql の revoke がまだ反映されていない
-- 可能性があるため、念のため確認2・確認4の結果と付き合わせてください）。
-- 行がある場合、default_acl 列の中身を見てください。"anon=r/postgres" のように
-- anon= や authenticated= から始まる権限が含まれていたら、それは「新しく作られるテーブルに
-- 自動でanon/authenticatedの権限が付く」設定が生きていることを意味し、異常です
-- （setup.sqlのrevoke文が想定通り効いていれば、通常はここにanon/authenticatedの
-- 文字列は出てこないはずです）。
select
  n.nspname as schema,
  d.defaclobjtype as object_type, -- r = テーブル、f = 関数、S = シーケンス
  array_to_string(d.defaclacl, E'\n') as default_acl
from pg_default_acl d
join pg_namespace n on n.oid = d.defaclnamespace
where n.nspname = 'public';


-- ----------------------------------------------------------------------------
-- 確認4（チェックリスト #14）: 旧シグネチャの関数が残っていないこと
-- ----------------------------------------------------------------------------
-- 【何を確認するのか】
-- consume_signup_attempt は過去に (text, integer) という2引数版から、現在の
-- (text, integer, text) という3引数版に変更されました（supabase/setup.sql が
-- "drop function if exists consume_signup_attempt(text, int);" で古い版を消してから
-- 新しい版を作る構成になっています）。この確認は、古い版が消し忘れられて
-- 残っていないかを見るものです。
--
-- 【期待する結果】
-- 1行だけ返り、その内容が "consume_signup_attempt(text, integer, text)" であること。
--
-- 【結果の読み方】
-- 2行以上表示された場合、あるいは "consume_signup_attempt(text, integer)"
-- （引数が2個の版）が含まれていた場合は異常です。古い関数が残っており、
-- 権限設定の対象漏れ（確認2で見ていない別のRPC）になっている可能性があるため、
-- 開発担当に連絡してください。
select oid::regprocedure
from pg_proc
where proname = 'consume_signup_attempt';


-- ----------------------------------------------------------------------------
-- 確認5（チェックリスト #3・低-3対応の補足）: publicスキーマのテーブルへの
-- 直接アクセス権限が anon / authenticated から revoke されていること
-- ----------------------------------------------------------------------------
-- 【何を確認するのか】
-- 確認3が「これから新しく作るテーブル」に対する既定権限の話だったのに対し、
-- こちらは「今すでに存在するテーブル」に対して、anon/authenticatedロールが
-- select/insert/update/delete のいずれかの権限を実際に持っていないかを、
-- PostgreSQLの標準ビュー（information_schema）で確認します。
-- ここに権限が残っていると、anonキー（＝利用者のブラウザがそのまま持っている鍵）から
-- stores.admin_key_hash や pending_signups.code_hash を直接読み書きできてしまいます。
--
-- 【期待する結果】
-- 0件（1行も返らない）。
--
-- 【結果の読み方】
-- 実行結果が「0 rows」であれば問題ありません。
-- 1行でも表示された場合、grantee列（anon か authenticated）・table_name列（どのテーブルか）・
-- privilege_type列（select/insert/update/deleteのどれか）を控えて開発担当に連絡してください。
-- 特に stores（admin_key_hash列を含む）や pending_signups（code_hash列を含む）に
-- 権限が残っている場合は、鍵の窃取や確認コードの直接照合に繋がるため優先度が高い異常です。
select
  grantee,
  table_name,
  privilege_type
from information_schema.role_table_grants
where table_schema = 'public'
  and grantee in ('anon', 'authenticated')
order by table_name, grantee, privilege_type;
