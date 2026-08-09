-- ============================================================================
-- scripts/verify-staging-summary.sql  ： 権限まわりの確認（かんたん版・1回で全部出ます）
--
-- 【使い方】
--   1. Supabase ダッシュボード → 対象プロジェクト → SQL Editor →「＋」で新しいクエリ
--   2. このファイルの中身を丸ごと貼り付けて「Run」
--   3. 表が1つ出ます。「判定」の列がすべて OK なら合格です
--
-- 【安全性】SELECT のみです。データもスキーマも一切変更しません。何度実行しても安全です。
--
-- 【どこで使うか】検証用（daida-staging）と本番の両方で実行してください。
--   本番反映のあとに本番で実行すると、設定が正しく入ったかを確認できます。
--
-- 【詳しく調べたいとき】どれかが「要確認」になったら、
--   scripts/verify-staging.sql（詳細版）を1クエリずつ実行してください。
-- ============================================================================

with
-- 確認1: 同じメールアドレスの pending_signups が重複していないか
c1 as (
  select count(*)::int as n
  from (select email from pending_signups group by email having count(*) > 1) t
),
-- 確認2a: 対象の RPC が2つとも存在するか
c2_total as (
  select count(*)::int as n
  from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
  where ns.nspname = 'public'
    and p.proname in ('consume_signup_attempt', 'request_signup_code')
),
-- 確認2b: その RPC に anon / authenticated の実行権限が残っていないか
c2_bad as (
  select count(*)::int as n
  from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
  where ns.nspname = 'public'
    and p.proname in ('consume_signup_attempt', 'request_signup_code')
    and (array_to_string(p.proacl, ',') like '%anon=%'
      or array_to_string(p.proacl, ',') like '%authenticated=%')
),
-- 確認3: これから作るテーブルに anon / authenticated の権限が自動で付く設定が残っていないか
--
-- 【なぜ postgres の行だけを見るのか】
-- Supabase は既定権限を postgres と supabase_admin の2つの役割で設定しています。
-- 既定権限は「そのテーブルを誰が作ったか」で決まります。
--   ・SQL Editor で作る → 作成者は postgres → この行の設定が適用される（＝我々が制御できる）
--   ・supabase_admin は Supabase 内部専用の役割で、利用者がテーブルを作る際には使われない
-- さらに supabase_admin の既定権限は権限不足で変更できません（permission denied になる）。
-- したがって supabase_admin の行に anon が残っているのは Supabase の仕様であり、
-- 実害も対処手段もありません。ここを判定対象に含めると「要確認」が永久に出続け、
-- 本当の異常を見逃す原因になるため、postgres の行だけを判定します。
--
-- 実際の防御は「確認5（既存テーブルへの権限が0件）」が担保しています。
-- 【重要】今後 public スキーマにテーブルを追加したときは、
--        supabase/setup.sql の revoke 対象の一覧にそのテーブル名を必ず追加してください。
c3_bad as (
  select count(*)::int as n
  from pg_default_acl d join pg_namespace ns on ns.oid = d.defaclnamespace
  where ns.nspname = 'public'
    and d.defaclobjtype = 'r'
    and d.defaclrole = 'postgres'::regrole
    and (array_to_string(d.defaclacl, ',') like '%anon=%'
      or array_to_string(d.defaclacl, ',') like '%authenticated=%')
),
-- 確認4a: consume_signup_attempt が何個あるか（1個が正しい）
c4_total as (
  select count(*)::int as n from pg_proc where proname = 'consume_signup_attempt'
),
-- 確認4b: 新しい3引数版が存在するか
c4_new as (
  select count(*)::int as n
  from pg_proc
  where proname = 'consume_signup_attempt'
    and oid::regprocedure::text like '%(text,integer,text)%'
),
-- 確認5: 既存テーブルに anon / authenticated の権限が残っていないか
c5 as (
  select count(*)::int as n
  from information_schema.role_table_grants
  where table_schema = 'public' and grantee in ('anon', 'authenticated')
)

select * from (
  select 1 as "順",
         '重複した確認コード行' as "確認内容",
         case when (select n from c1) = 0 then 'OK' else '要確認' end as "判定",
         '重複しているメール: ' || (select n from c1)::text || ' 件（期待: 0 件）' as "詳細"
  union all
  select 2,
         'RPCの実行権限',
         case when (select n from c2_total) = 2 and (select n from c2_bad) = 0
              then 'OK' else '要確認' end,
         'RPCの数: ' || (select n from c2_total)::text || '（期待: 2）／ '
         || 'anon等に実行権限が残るRPC: ' || (select n from c2_bad)::text || '（期待: 0）'
  union all
  select 3,
         '新規テーブルの既定権限',
         case when (select n from c3_bad) = 0 then 'OK' else '要確認' end,
         'postgres作成時にanon等へ自動付与する設定: ' || (select n from c3_bad)::text
         || ' 件（期待: 0 件）／ ※supabase_admin の分はSupabaseの仕様で変更不可・実害なし'
  union all
  select 4,
         '旧シグネチャの関数',
         case when (select n from c4_total) = 1 and (select n from c4_new) = 1
              then 'OK' else '要確認' end,
         'consume_signup_attempt の数: ' || (select n from c4_total)::text || '（期待: 1）／ '
         || '3引数版の有無: ' || (select n from c4_new)::text || '（期待: 1）'
  union all
  select 5,
         '既存テーブルへのanon権限',
         case when (select n from c5) = 0 then 'OK' else '要確認' end,
         'anon等に残る権限: ' || (select n from c5)::text || ' 件（期待: 0 件）'
) t
order by "順";
