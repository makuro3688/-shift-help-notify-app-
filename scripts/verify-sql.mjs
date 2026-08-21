// supabase/setup.sql を「本物のPostgreSQL」に対して実際に実行して検証するスクリプト。
//
// 実行方法：
//   npm run verify-sql
//
// --- なぜこれが必要か（過去2回、リリースがこれで止まった） ---
// このプロジェクトでは、リリース直前に2度、同じ種類のSQLエラーで作業が止まっている。
//
//   1回目: delete from pending_signups where id = v_id;
//          → RETURNS TABLE (id uuid, ...) のOUTパラメータ id と衝突
//   2回目: on conflict (store_id)
//          → RETURNS TABLE (store_id uuid, ...) のOUTパラメータ store_id と衝突
//
// どちらも ERROR 42702 (ambiguous) で、**CREATE FUNCTION は成功する**。
// PL/pgSQL の変数名衝突は、その行が実際に実行されて初めて例外になるため、
// 「SQLを流したときは成功したのに、本番で初めて落ちる」という形で現れる。
// テストは全件通っていた（テストがSQLに到達しないため、当然）。
//
// PGlite（WebAssembly版のPostgreSQL）を使えば、Supabaseに触らずに、
// 手元で setup.sql を最初から流し、関数を実際に呼び出して確認できる。
//
// --- このスクリプトが確認すること ---
//   ① setup.sql の全文が、真っさらなDBに対して先頭から最後まで通ること
//      （中-2の教訓：revoke対象のテーブルがrevoke文より後ろで定義されていると、
//        新規環境でだけ全体がロールバックする）
//   ② 各RPCを実際に呼び出し、実行時エラー（42702等）が出ないこと
//   ③ 確認コードの判定（正解・誤り・再使用・上限・期限切れ）が仕様どおりであること
//   ④ anon / authenticated にテーブル権限が残っていないこと（低-3・低-5）
//
// --- 限界（正直に書いておく） ---
// PGliteは単一接続のため、**同時実行（レース条件）は再現できない**。
// 「行ロックによって、同じコードが2回使えない」ことの確認は、
// 単一接続での逐次実行による確認までしかできていない。
// 同時実行の担保は、単一のUPDATE文で完結させるという設計そのものに依っている。

// PGliteは開発用の依存（devDependencies）であり、本番（Render）には入らない。
// NODE_ENV=production の環境では npm install が devDependencies を入れないため、
// 本番の起動やデプロイには一切影響しない。
// 手元に入っていない場合は、何が足りないかを分かる形で伝えて終わる。
let PGlite;
try {
  ({ PGlite } = await import('@electric-sql/pglite'));
} catch (e) {
  console.log('このスクリプトには PGlite（WebAssembly版のPostgreSQL）が必要です。');
  console.log('次のコマンドで入れてから、もう一度実行してください：');
  console.log('\n  npm install\n');
  process.exit(1);
}

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const SETUP_SQL = path.join(here, '..', 'supabase', 'setup.sql');

const hash = (s) => crypto.createHash('sha256').update(s).digest('hex');

let failures = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`  ${ok ? '✅' : '❌'} ${label}` + (ok ? '' : `\n      期待: ${JSON.stringify(expected)}\n      実際: ${JSON.stringify(actual)}`));
}

const db = await new PGlite();

// Supabaseが既定で持っているロール。PGliteには無いので先に作る
// （setup.sqlのrevoke/grantがこれらを参照するため）。
await db.exec('create role anon; create role authenticated; create role service_role;');

console.log('① setup.sql の全文を、真っさらなDBに流す');
const sql = fs.readFileSync(SETUP_SQL, 'utf8');
try {
  await db.exec(sql);
  console.log('  ✅ 先頭から最後まで通った');
} catch (e) {
  console.log('  ❌ 失敗:', e.message);
  console.log('\n【重要】本番・stagingにこのSQLを流す前に、必ずここを直してください。');
  process.exit(1);
}

console.log('\n② テーブル・関数・今回の列が揃っているか');
const tables = (await db.query("select table_name from information_schema.tables where table_schema='public' order by 1")).rows.map((r) => r.table_name);
const routines = (await db.query("select routine_name from information_schema.routines where routine_schema='public' order by 1")).rows.map((r) => r.routine_name);
console.log('  テーブル:', tables.join(', '));
console.log('  関数    :', routines.join(', '));
for (const col of ['email', 'pending_email', 'pending_email_code_hash', 'pending_email_expires_at', 'pending_email_attempts']) {
  const r = await db.query("select 1 from information_schema.columns where table_name='supervisor_keys' and column_name=$1", [col]);
  check(`supervisor_keys.${col} がある`, r.rows.length > 0, true);
}
const sc = await db.query("select 1 from information_schema.columns where table_name='shifts' and column_name='created_by_supervisor_id'");
check('shifts.created_by_supervisor_id がある', sc.rows.length > 0, true);

console.log('\n③ anon / authenticated にテーブル権限が残っていないか（低-3）');
const grants = await db.query(
  "select grantee, table_name, privilege_type from information_schema.role_table_grants where grantee in ('anon','authenticated') and table_schema='public'"
);
check('anon/authenticated へのテーブル権限は0件', grants.rows.length, 0);

console.log('\n④ consume_supervisor_email_code を実際に呼び出す（42702はここで初めて出る）');
const store = await db.query("insert into stores(name, admin_key_hash, email) values('検証店','dummy-hash','owner@example.com') returning id");
const storeId = store.rows[0].id;
const key = await db.query("insert into supervisor_keys(store_id, admin_key_hash, label) values($1,'sup-hash','検証') returning id", [storeId]);
const supId = key.rows[0].id;

async function setPending(email, code, minutes = 10, attempts = 0) {
  await db.query(
    `update supervisor_keys set pending_email=$1, pending_email_code_hash=$2,
       pending_email_expires_at = now() + ($3 || ' minutes')::interval, pending_email_attempts=$4
     where id=$5`,
    [email, hash(code), String(minutes), attempts, supId]
  );
}
const call = async (code, max = 5) =>
  (await db.query('select * from consume_supervisor_email_code($1,$2,$3)', [supId, max, hash(code)])).rows[0];
const currentEmail = async () => (await db.query('select email from supervisor_keys where id=$1', [supId])).rows[0].email;
const clearEmail = async () => db.query('update supervisor_keys set email=null where id=$1', [supId]);

await setPending('sup@example.com', '123456');
check('正しいコードで一致する', await call('123456'), { out_email: 'sup@example.com', out_matched: true });
check('  → emailに昇格している', await currentEmail(), 'sup@example.com');

check('同じコードは2回使えない', await call('123456'), { out_email: null, out_matched: false });

await clearEmail();
await setPending('sup@example.com', '123456');
check('違うコードは通らない', await call('999999'), { out_email: null, out_matched: false });
const attempts = (await db.query('select pending_email_attempts from supervisor_keys where id=$1', [supId])).rows[0].pending_email_attempts;
check('  → 試行回数が1つ消費されている', attempts, 1);
check('  → emailは書き換わっていない', await currentEmail(), null);

await setPending('sup@example.com', '123456', 10, 5);
check('上限に達したら正しいコードでも通らない', await call('123456'), { out_email: null, out_matched: false });

await setPending('sup@example.com', '123456', -1);
check('期限切れは通らない', await call('123456'), { out_email: null, out_matched: false });

await db.query('update supervisor_keys set pending_email=null, pending_email_code_hash=null where id=$1', [supId]);
check('保留が無ければ通らない', await call('123456'), { out_email: null, out_matched: false });

console.log('\n⑤ 時間帯責任者キーを失効させても、募集履歴は消えない（on delete set null）');
await db.query(
  "insert into shifts(store_id, store_name, date, time, created_by_supervisor_id) values($1,'検証店','2026-08-25','18:00〜22:00',$2)",
  [storeId, supId]
);
await db.query('delete from supervisor_keys where id=$1', [supId]);
const shiftCount = (await db.query('select count(*)::int c from shifts')).rows[0].c;
const sender = (await db.query('select created_by_supervisor_id from shifts')).rows[0].created_by_supervisor_id;
check('募集履歴は残る（cascadeで消えない）', shiftCount, 1);
check('送信者だけがnullになる', sender, null);

console.log('\n⑥ 他のRPCも実行時に落ちないか（過去2回のエラーはここで出た）');
try {
  await db.query("select * from request_signup_code($1,$2,$3,$4,$5)", ['sql-check@example.com', '検証店', hash('111111'), new Date(Date.now() + 600000).toISOString(), 60]);
  console.log('  ✅ request_signup_code');
  const r = await db.query('select * from consume_signup_attempt($1,$2,$3)', ['sql-check@example.com', 5, hash('111111')]);
  check('consume_signup_attempt が一致を返す', r.rows[0].matched, true);
  await db.query('select * from request_key_recovery_code($1,$2,$3)', ['owner@example.com', hash('222222'), new Date(Date.now() + 600000).toISOString()]);
  console.log('  ✅ request_key_recovery_code');
  const r2 = await db.query('select * from consume_key_recovery_attempt($1,$2,$3)', ['owner@example.com', 5, hash('222222')]);
  check('consume_key_recovery_attempt が一致を返す', r2.rows[0].matched, true);
} catch (e) {
  failures++;
  console.log('  ❌ 実行時エラー:', e.message);
}

console.log('\n' + '='.repeat(50));
if (failures === 0) {
  console.log('✅ すべて通りました。このSQLはSupabaseに流して問題ありません。');
} else {
  console.log(`❌ ${failures}件の問題があります。本番に流す前に直してください。`);
  process.exit(1);
}
