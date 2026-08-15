'use strict';

// 管理者キー復旧（/api/recovery/request-code, /api/recovery/verify-code）の受け入れ条件を検証する。
//
// 対象の受け入れ条件（完了報告のAC-K1〜AC-K8に対応）：
//   AC-K1: 登録メールに確認コードが送られ、正しく入力すると新しい管理者キーが発行される
//   AC-K2: 再発行後、古いキーではログインできない（★特に重要）
//   AC-K3: 再発行後も、時間帯責任者キーは引き続き使える
//   AC-K4: 再発行してもスタッフ・募集履歴・課金状態が変化しない
//   AC-K5: 確認コードを5回間違えると失効し、その後は正しいコードでも通らない（★特に重要）
//   AC-K6: 登録されていないメールアドレスでも、登録済みと同じ応答が返る（★特に重要）
//   AC-K7: コード送信要求にレート制限（IP・メール・グローバル）がかかっている
//   AC-K8: 既存テスト・既存フローが壊れていないことは `npm test` 全体で検証する
//
// 店舗登録のテスト（test/signup.test.js, test/signupBruteForce.test.js）と同じ方針で、
// server.jsが実際に構築するExpressアプリ（buildApp()）と、本物のlib/keyRecovery.jsを
// フェイクのSupabase（.rpc()・.from()）越しに検証する。ハンドラを手で複製しない。
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { createRateLimiter } = require('../lib/rateLimit');
const {
  requestKeyRecoveryCode,
  verifyKeyRecoveryCode,
  padUntil,
  KEY_RECOVERY_CODE_MAX_ATTEMPTS,
  KEY_RECOVERY_VERIFY_FAILED_MESSAGE,
} = require('../lib/keyRecovery');

// server.jsは/api/signup/request-codeと同じ理由で、requireする前にRESEND_API_KEYの
// ダミー値が無いと/api/recovery/request-codeが即座に500を返す（実際のメール送信は
// buildApp()のoverrides.sendKeyRecoveryCodeEmailで差し替える）。
if (!process.env.RESEND_API_KEY) {
  process.env.RESEND_API_KEY = 'test-dummy-resend-api-key';
}
const { buildApp } = require('../server');

// server.jsのhashKey（SHA-256）と同じアルゴリズム。
function hashKey(key) {
  return crypto.createHash('sha256').update(key).digest('hex');
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// 【中-4是正に伴うテストの変更】メール送信が応答後の非同期処理(setImmediate)になったため、
// request-codeへのPOSTがresolveした時点では、まだテスト側のsendKeyRecoveryCodeEmailの
// フェイクが呼ばれていない可能性がある（応答の送信とメール送信はもう同期していない）。
// このヘルパーは、conditionFnがtrueになるまで短い間隔でポーリングする
// （setImmediateは基本的に次のイベントループでほぼ即座に実行されるため、待ち時間はごく短い）。
function waitFor(conditionFn, { timeoutMs = 1000, intervalMs = 5 } = {}) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    (function check() {
      if (conditionFn()) return resolve();
      if (Date.now() > deadline) return reject(new Error('waitFor: タイムアウト（条件が満たされなかった）'));
      setTimeout(check, intervalMs);
    })();
  });
}

const FUTURE = new Date(Date.now() + 15 * 60 * 1000).toISOString();
const PAST = new Date(Date.now() - 1000).toISOString();

// ============================================================
// フェイクSupabase：stores・supervisor_keys・key_recovery_requests（RPC経由）を模す。
// supabase/setup.sqlのrequest_key_recovery_code / consume_key_recovery_attemptと
// 同じ判定（メールアドレスから対象店舗をcreated_at降順で1件特定し、原子的に試行枠を
// 消費・照合する）を、フェイク側でも再現する。
// ============================================================
function createFakeSupabase({ stores = [], supervisorKeys = [], rpcDelayMs = 0 } = {}) {
  const storesArr = stores.map((s) => ({ ...s }));
  const supervisorArr = supervisorKeys.map((s) => ({ ...s }));
  const recoveryRows = new Map(); // store_id -> { code_hash, expires_at, attempts }
  const untouchedTables = new Set();

  function findStoreByEmail(email) {
    const matches = storesArr.filter((s) => s.email === email);
    if (matches.length === 0) return null;
    matches.sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0));
    return matches[0];
  }

  function selectChain(rows) {
    return {
      eq(col, val) {
        const chain = {
          maybeSingle() {
            const found = rows.find((r) => r[col] === val);
            return Promise.resolve({ data: found || null, error: null });
          },
          limit() {
            return chain;
          },
        };
        return chain;
      },
    };
  }

  const supabase = {
    from(table) {
      if (table === 'stores') {
        return {
          select() {
            return selectChain(storesArr);
          },
          update(payload) {
            return {
              eq(col, val) {
                const row = storesArr.find((r) => r[col] === val);
                if (!row) return Promise.resolve({ error: { message: 'not found' } });
                Object.assign(row, payload);
                return Promise.resolve({ error: null });
              },
            };
          },
        };
      }
      if (table === 'supervisor_keys') {
        return {
          select() {
            return selectChain(supervisorArr);
          },
        };
      }
      // AC-K4の検証用：想定外のテーブル（subscriptions・shifts等）へのアクセスが
      // あれば、それ自体がバグ（スタッフ・募集履歴に触れてはいけない）なので例外にする。
      untouchedTables.add(table);
      throw new Error(`想定外のテーブルへのアクセス: ${table}`);
    },
    rpc(fnName, params) {
      if (fnName === 'request_key_recovery_code') {
        const store = findStoreByEmail(params.p_email);
        if (!store) {
          return delay(rpcDelayMs).then(() => ({ data: [], error: null }));
        }
        recoveryRows.set(store.id, {
          code_hash: params.p_code_hash,
          expires_at: params.p_expires_at,
          attempts: 0,
        });
        // 【中-1是正】本物のRPC(request_key_recovery_code)はRETURNS TABLE (out_store_id,
        // out_store_name) を返す（store_id/store_nameという名前はON CONFLICT句の推定列名と
        // 衝突するため使えない。setup.sql参照）。フェイクも同じ列名で返し、
        // lib/keyRecovery.jsの受け取り側（row.out_store_id）と実際に噛み合うことを検証する。
        return delay(rpcDelayMs).then(() => ({
          data: [{ out_store_id: store.id, out_store_name: store.name }],
          error: null,
        }));
      }
      if (fnName === 'consume_key_recovery_attempt') {
        const store = findStoreByEmail(params.p_email);
        if (!store) {
          return delay(rpcDelayMs).then(() => ({ data: [], error: null }));
        }
        const row = recoveryRows.get(store.id);
        const withinLimits = row && row.attempts < params.p_max && new Date(row.expires_at) > new Date();
        if (!withinLimits) {
          return delay(rpcDelayMs).then(() => ({
            data: [{ store_id: store.id, matched: false }],
            error: null,
          }));
        }
        row.attempts += 1;
        const matched = row.code_hash === params.p_code_hash;
        if (matched) recoveryRows.delete(store.id);
        return delay(rpcDelayMs).then(() => ({
          data: [{ store_id: store.id, matched }],
          error: null,
        }));
      }
      throw new Error(`想定外のRPC呼び出し: ${fnName}`);
    },
  };

  return { supabase, storesArr, supervisorArr, recoveryRows };
}

function postJson(server, path, body) {
  return new Promise((resolve, reject) => {
    const { port } = server.address();
    const payload = JSON.stringify(body);
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        method: 'POST',
        path,
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) },
      },
      (res) => {
        let responseBody = '';
        res.on('data', (chunk) => (responseBody += chunk));
        res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(responseBody || '{}') }));
      }
    );
    req.on('error', reject);
    req.end(payload);
  });
}

function getJson(server, path, headers) {
  return new Promise((resolve, reject) => {
    const { port } = server.address();
    const req = http.request({ host: '127.0.0.1', port, method: 'GET', path, headers }, (res) => {
      let responseBody = '';
      res.on('data', (chunk) => (responseBody += chunk));
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(responseBody || '{}') }));
    });
    req.on('error', reject);
    req.end();
  });
}

const HIGH_LIMIT = 100000; // レート制限を実質無効化するための大きい上限
const TEST_WINDOW_MS = 60 * 60 * 1000;

// テスト用に、レート制限・応答パディングを無効化（floor=0）した状態でbuildApp()する。
// 本番の挙動はoverridesを渡さない限り一切変わらない（server.js側のコメント参照）。
function buildFastApp(overrides) {
  return buildApp({
    recoveryRequestCodeIpLimiter: createRateLimiter(TEST_WINDOW_MS, HIGH_LIMIT),
    recoveryRequestCodeEmailLimiter: createRateLimiter(TEST_WINDOW_MS, HIGH_LIMIT),
    recoveryRequestCodeGlobalLimiter: createRateLimiter(TEST_WINDOW_MS, HIGH_LIMIT),
    recoveryVerifyCodeIpLimiter: createRateLimiter(TEST_WINDOW_MS, HIGH_LIMIT),
    keyRecoveryRequestMinResponseTimeMs: 0,
    keyRecoveryVerifyMinResponseTimeMs: 0,
    ...overrides,
  });
}

function makeStore(overrides = {}) {
  return {
    id: overrides.id || crypto.randomUUID(),
    name: '牛久店',
    email: 'owner@example.com',
    admin_key_hash: hashKey('old-admin-key'),
    created_at: new Date().toISOString(),
    subscription_status: 'trial',
    subscription_plan: null,
    stripe_customer_id: null,
    stripe_subscription_id: null,
    current_period_end: null,
    skip_free_trial: false,
    ...overrides,
  };
}

// ============================================================
// AC-K1: 登録メールに確認コードが送られ、正しく入力すると新しい管理者キーが発行される
// ============================================================

test('正常系(AC-K1): 登録済みメールに確認コードを送り、正しいコードを入力すると新しい管理者キーが発行される', async () => {
  const store = makeStore();
  const { supabase } = createFakeSupabase({ stores: [store] });
  const sentCodes = [];
  const app = buildFastApp({
    supabase,
    sendKeyRecoveryCodeEmail: async (email, code) => {
      sentCodes.push({ email, code });
    },
  });
  const server = app.listen(0);
  try {
    const reqRes = await postJson(server, '/api/recovery/request-code', { email: store.email });
    assert.strictEqual(reqRes.status, 200);
    // 【中-4是正】メール送信は応答後の非同期処理になったため、応答直後ではなく
    // 実際に送信されるまで待つ。
    await waitFor(() => sentCodes.length > 0);
    assert.strictEqual(sentCodes.length, 1);
    assert.strictEqual(sentCodes[0].email, store.email);
    assert.match(sentCodes[0].code, /^\d{6}$/);

    const verifyRes = await postJson(server, '/api/recovery/verify-code', {
      email: store.email,
      code: sentCodes[0].code,
    });
    assert.strictEqual(verifyRes.status, 200);
    assert.match(verifyRes.body.adminKey, /^[0-9a-f]{40}$/);
    assert.notStrictEqual(verifyRes.body.adminKey, 'old-admin-key');
  } finally {
    server.close();
  }
});

test('異常系(AC-K1): 確認コードを送らずに（＝保留行が無い状態で）検証しても失敗する', async () => {
  const store = makeStore();
  const { supabase } = createFakeSupabase({ stores: [store] });
  const app = buildFastApp({ supabase });
  const server = app.listen(0);
  try {
    const res = await postJson(server, '/api/recovery/verify-code', { email: store.email, code: '123456' });
    assert.strictEqual(res.status, 400);
    assert.strictEqual(res.body.error, KEY_RECOVERY_VERIFY_FAILED_MESSAGE);
  } finally {
    server.close();
  }
});

// ============================================================
// AC-K2（★特に重要）: 再発行後、古いキーではログインできない
// ============================================================

test('正常系(AC-K2): 再発行前は旧キーでログインできる', async () => {
  const store = makeStore();
  const { supabase } = createFakeSupabase({ stores: [store] });
  const app = buildFastApp({ supabase });
  const server = app.listen(0);
  try {
    const res = await getJson(server, '/api/me', { 'x-admin-key': 'old-admin-key' });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.role, 'owner');
  } finally {
    server.close();
  }
});

test('異常系(AC-K2・核心): 管理者キーを再発行すると、旧キーではもうログインできない（401）', async () => {
  const store = makeStore();
  const { supabase, storesArr } = createFakeSupabase({ stores: [store] });
  let sentCode = null;
  const app = buildFastApp({
    supabase,
    sendKeyRecoveryCodeEmail: async (email, code) => {
      sentCode = code;
    },
  });
  const server = app.listen(0);
  try {
    // 再発行前は旧キーで入れることを確認しておく（対比のため）。
    const before = await getJson(server, '/api/me', { 'x-admin-key': 'old-admin-key' });
    assert.strictEqual(before.status, 200);

    await postJson(server, '/api/recovery/request-code', { email: store.email });
    // 【中-4是正】メール送信は応答後の非同期処理になったため、実際に送信されるまで待つ。
    await waitFor(() => sentCode !== null);
    assert.ok(sentCode, '確認コードが送信されているはず');
    const verifyRes = await postJson(server, '/api/recovery/verify-code', { email: store.email, code: sentCode });
    assert.strictEqual(verifyRes.status, 200);
    const newAdminKey = verifyRes.body.adminKey;

    // 【核心】旧キーはもう使えない。
    const afterOld = await getJson(server, '/api/me', { 'x-admin-key': 'old-admin-key' });
    assert.strictEqual(afterOld.status, 401);

    // 新しいキーではログインできる。
    const afterNew = await getJson(server, '/api/me', { 'x-admin-key': newAdminKey });
    assert.strictEqual(afterNew.status, 200);
    assert.strictEqual(afterNew.body.role, 'owner');

    // DB上のハッシュも実際に新しいキーのものに書き換わっている（応答だけでなく実データを確認）。
    assert.strictEqual(storesArr[0].admin_key_hash, hashKey(newAdminKey));
    assert.notStrictEqual(storesArr[0].admin_key_hash, hashKey('old-admin-key'));
  } finally {
    server.close();
  }
});

// ============================================================
// AC-K3: 再発行後も、時間帯責任者キーは引き続き使える
// ============================================================

test('正常系(AC-K3): 管理者キーを再発行しても、時間帯責任者キーはそのままログインできる', async () => {
  const store = makeStore();
  const supervisorKey = { id: 'sup-1', store_id: store.id, admin_key_hash: hashKey('supervisor-key'), label: '土曜夜担当' };
  const { supabase } = createFakeSupabase({ stores: [store], supervisorKeys: [supervisorKey] });
  let sentCode = null;
  const app = buildFastApp({
    supabase,
    sendKeyRecoveryCodeEmail: async (email, code) => {
      sentCode = code;
    },
  });
  const server = app.listen(0);
  try {
    await postJson(server, '/api/recovery/request-code', { email: store.email });
    // 【中-4是正】メール送信は応答後の非同期処理になったため、実際に送信されるまで待つ。
    await waitFor(() => sentCode !== null);
    await postJson(server, '/api/recovery/verify-code', { email: store.email, code: sentCode });

    const res = await getJson(server, '/api/me', { 'x-admin-key': 'supervisor-key' });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.role, 'supervisor');
    assert.strictEqual(res.body.storeId, store.id);
  } finally {
    server.close();
  }
});

test('異常系(AC-K3・対比): 存在しない時間帯責任者キーは、再発行後も引き続きログインできない', async () => {
  const store = makeStore();
  const supervisorKey = { id: 'sup-1', store_id: store.id, admin_key_hash: hashKey('supervisor-key') };
  const { supabase } = createFakeSupabase({ stores: [store], supervisorKeys: [supervisorKey] });
  let sentCode = null;
  const app = buildFastApp({
    supabase,
    sendKeyRecoveryCodeEmail: async (email, code) => {
      sentCode = code;
    },
  });
  const server = app.listen(0);
  try {
    await postJson(server, '/api/recovery/request-code', { email: store.email });
    // 【中-4是正】メール送信は応答後の非同期処理になったため、実際に送信されるまで待つ。
    await waitFor(() => sentCode !== null);
    await postJson(server, '/api/recovery/verify-code', { email: store.email, code: sentCode });

    const res = await getJson(server, '/api/me', { 'x-admin-key': 'never-issued-supervisor-key' });
    assert.strictEqual(res.status, 401);
  } finally {
    server.close();
  }
});

// ============================================================
// AC-K4: 再発行してもスタッフ・募集履歴・課金状態が変化しない
// ============================================================

test('正常系(AC-K4): 管理者キーを再発行しても、admin_key_hash以外の店舗データ（課金状態等）は変化しない', async () => {
  const store = makeStore({
    subscription_status: 'active',
    subscription_plan: 'yearly',
    stripe_customer_id: 'cus_123',
    stripe_subscription_id: 'sub_123',
    current_period_end: '2027-01-01T00:00:00.000Z',
    skip_free_trial: true,
  });
  const { supabase, storesArr } = createFakeSupabase({ stores: [store] });
  const before = { ...storesArr[0] };
  let sentCode = null;
  const app = buildFastApp({
    supabase,
    sendKeyRecoveryCodeEmail: async (email, code) => {
      sentCode = code;
    },
  });
  const server = app.listen(0);
  try {
    await postJson(server, '/api/recovery/request-code', { email: store.email });
    // 【中-4是正】メール送信は応答後の非同期処理になったため、実際に送信されるまで待つ。
    await waitFor(() => sentCode !== null);
    const verifyRes = await postJson(server, '/api/recovery/verify-code', { email: store.email, code: sentCode });
    assert.strictEqual(verifyRes.status, 200);

    const after = storesArr[0];
    // admin_key_hash以外の全列が変化していないことを確認する。
    for (const key of Object.keys(before)) {
      if (key === 'admin_key_hash') continue;
      assert.deepStrictEqual(after[key], before[key], `${key} が変化してはいけない`);
    }
    assert.notStrictEqual(after.admin_key_hash, before.admin_key_hash);

    // 【構造的な保証】このテストのフェイクSupabaseは、'stores'と'supervisor_keys'以外の
    // テーブル（subscriptions・shifts等、スタッフ・募集履歴を保持するテーブル）への
    // アクセスがあれば例外を投げる。ここまで例外なく到達していること自体が、
    // 復旧フローがそれらのテーブルに一切触れていない証拠になる。
  } finally {
    server.close();
  }
});

// ============================================================
// AC-K5（★特に重要）: 確認コードを5回間違えると失効し、その後は正しいコードでも通らない
// ============================================================

test('正常系(AC-K5): 1〜4回誤っても、その後正しいコードを入れれば通る（上限前は通常どおり動く）', async () => {
  const store = makeStore();
  const { supabase } = createFakeSupabase({ stores: [store] });
  let sentCode = null;
  const app = buildFastApp({
    supabase,
    sendKeyRecoveryCodeEmail: async (email, code) => {
      sentCode = code;
    },
  });
  const server = app.listen(0);
  try {
    await postJson(server, '/api/recovery/request-code', { email: store.email });
    // 【中-4是正】メール送信は応答後の非同期処理になったため、実際に送信されるまで待つ。
    await waitFor(() => sentCode !== null);

    for (let i = 0; i < KEY_RECOVERY_CODE_MAX_ATTEMPTS - 1; i++) {
      const wrong = await postJson(server, '/api/recovery/verify-code', { email: store.email, code: '000000' });
      assert.strictEqual(wrong.status, 400);
    }
    const success = await postJson(server, '/api/recovery/verify-code', { email: store.email, code: sentCode });
    assert.strictEqual(success.status, 200);
    assert.ok(success.body.adminKey);
  } finally {
    server.close();
  }
});

test('異常系(AC-K5・核心): 5回間違えると失効し、その後は正しいコードを入力しても通らない', async () => {
  const store = makeStore();
  const { supabase } = createFakeSupabase({ stores: [store] });
  let sentCode = null;
  const app = buildFastApp({
    supabase,
    sendKeyRecoveryCodeEmail: async (email, code) => {
      sentCode = code;
    },
  });
  const server = app.listen(0);
  try {
    await postJson(server, '/api/recovery/request-code', { email: store.email });
    // 【中-4是正】メール送信は応答後の非同期処理になったため、実際に送信されるまで待つ。
    await waitFor(() => sentCode !== null);

    for (let i = 0; i < KEY_RECOVERY_CODE_MAX_ATTEMPTS; i++) {
      const wrong = await postJson(server, '/api/recovery/verify-code', { email: store.email, code: '000000' });
      assert.strictEqual(wrong.status, 400);
    }

    // 【核心】6回目に正しいコードを入力しても、もう通らない。
    const afterLockout = await postJson(server, '/api/recovery/verify-code', { email: store.email, code: sentCode });
    assert.strictEqual(afterLockout.status, 400);
    assert.strictEqual(afterLockout.body.error, KEY_RECOVERY_VERIFY_FAILED_MESSAGE);

    // 失効後も旧キーはまだ有効（＝再発行が成立していないことの確認）。
    const stillOldKey = await getJson(server, '/api/me', { 'x-admin-key': 'old-admin-key' });
    assert.strictEqual(stillOldKey.status, 200);
  } finally {
    server.close();
  }
});

// lib/keyRecovery.jsのverifyKeyRecoveryCodeを直接使った、境界値の単体テスト
// （consume_key_recovery_attempt RPCの原子性そのものはsupabase/setup.sqlのplpgsqlのため
// 直接単体テストできないが、フェイクRPCを介してJS側の呼び出し契約を検証する）。
test('境界値(AC-K5): ちょうど4回目・5回目・6回目の挙動', async () => {
  const store = makeStore({ email: 'boundary-recovery@example.com' });
  const { supabase, recoveryRows } = createFakeSupabase({ stores: [store] });
  const correctCode = '135791';
  await requestKeyRecoveryCode({ supabase, email: store.email, codeHash: hashKey(correctCode), expiresAt: FUTURE });

  for (let i = 0; i < 3; i++) {
    await verifyKeyRecoveryCode({ supabase, email: store.email, code: 'wrong0' + i, hashCode: hashKey, maxAttempts: KEY_RECOVERY_CODE_MAX_ATTEMPTS });
  }
  assert.strictEqual(recoveryRows.get(store.id).attempts, 3);

  const fourth = await verifyKeyRecoveryCode({ supabase, email: store.email, code: 'wrong04', hashCode: hashKey, maxAttempts: KEY_RECOVERY_CODE_MAX_ATTEMPTS });
  assert.strictEqual(fourth.ok, false);
  assert.strictEqual(recoveryRows.get(store.id).attempts, 4);

  const fifth = await verifyKeyRecoveryCode({ supabase, email: store.email, code: 'wrong05', hashCode: hashKey, maxAttempts: KEY_RECOVERY_CODE_MAX_ATTEMPTS });
  assert.strictEqual(fifth.ok, false);
  assert.strictEqual(recoveryRows.get(store.id).attempts, 5);

  const sixth = await verifyKeyRecoveryCode({ supabase, email: store.email, code: correctCode, hashCode: hashKey, maxAttempts: KEY_RECOVERY_CODE_MAX_ATTEMPTS });
  assert.strictEqual(sixth.ok, false);
  assert.strictEqual(recoveryRows.get(store.id).attempts, 5); // これ以上増えない
});

test('異常系: 期限切れの保留行は、attemptsを進めずに失敗する', async () => {
  const store = makeStore({ email: 'expired-recovery@example.com' });
  const { supabase, recoveryRows } = createFakeSupabase({ stores: [store] });
  await requestKeyRecoveryCode({ supabase, email: store.email, codeHash: hashKey('999999'), expiresAt: PAST });
  const result = await verifyKeyRecoveryCode({ supabase, email: store.email, code: '999999', hashCode: hashKey, maxAttempts: KEY_RECOVERY_CODE_MAX_ATTEMPTS });
  assert.strictEqual(result.ok, false);
  assert.strictEqual(recoveryRows.get(store.id).attempts, 0);
});

// ============================================================
// AC-K6（★特に重要）: 登録されていないメールアドレスでも、登録済みと同じ応答が返る
// ============================================================

test('正常系(AC-K6): 登録済みメールと未登録メールで、request-codeの応答（ステータス・文言）が完全に一致する', async () => {
  const store = makeStore({ email: 'registered-for-k6@example.com' });
  const { supabase } = createFakeSupabase({ stores: [store] });
  const app = buildFastApp({
    supabase,
    sendKeyRecoveryCodeEmail: async () => {},
  });
  const server = app.listen(0);
  try {
    const registered = await postJson(server, '/api/recovery/request-code', { email: store.email });
    const unregistered = await postJson(server, '/api/recovery/request-code', { email: 'never-registered@example.com' });

    assert.strictEqual(registered.status, unregistered.status);
    // メッセージ本文にはメールアドレスをそのまま埋め込んでいるため、その部分だけ揃えて比較する。
    const normalize = (msg, email) => msg.replace(email, '{email}');
    assert.strictEqual(
      normalize(registered.body.message, store.email),
      normalize(unregistered.body.message, 'never-registered@example.com')
    );
  } finally {
    server.close();
  }
});

test('異常系(AC-K6・核心): 未登録メールに対してはメール送信自体が発生しないが、応答は登録済みと区別できない', async () => {
  const store = makeStore({ email: 'registered-for-k6b@example.com' });
  const { supabase } = createFakeSupabase({ stores: [store] });
  const sentTo = [];
  const app = buildFastApp({
    supabase,
    sendKeyRecoveryCodeEmail: async (email) => {
      sentTo.push(email);
    },
  });
  const server = app.listen(0);
  try {
    await postJson(server, '/api/recovery/request-code', { email: 'never-registered-2@example.com' });
    // 未登録メールはstoreIdがnullのため、メール送信自体がそもそもスケジュールされない
    // （setImmediateが一切呼ばれない）。したがってここは待たなくても常にfalseのまま。
    assert.deepStrictEqual(sentTo, [], '未登録メールにはメールを送ってはいけない');

    const res = await postJson(server, '/api/recovery/request-code', { email: store.email });
    assert.strictEqual(res.status, 200);
    // 【中-4是正】メール送信は応答後の非同期処理になったため、実際に送信されるまで待つ。
    await waitFor(() => sentTo.length > 0);
    assert.deepStrictEqual(sentTo, [store.email], '登録済みメールには実際に送信される');
  } finally {
    server.close();
  }
});

test('異常系(AC-K6・タイミング): 登録済み/未登録で応答の所要時間に顕著な差が出ない（応答パディングが機能している）', async () => {
  const store = makeStore({ email: 'timing-check@example.com' });
  const { supabase } = createFakeSupabase({ stores: [store] });
  // 登録済みの場合だけ実際に「メール送信」がネットワーク往復を模した遅延を挟む
  // （本番でいうResend APIへのfetch相当）。パディング無し(floor=0)なら、
  // 登録済み/未登録で明確な時間差が出るはずの設定にしている。
  const SIMULATED_MAIL_LATENCY_MS = 120;
  const RESPONSE_FLOOR_MS = 200;
  const app = buildApp({
    supabase,
    recoveryRequestCodeIpLimiter: createRateLimiter(TEST_WINDOW_MS, HIGH_LIMIT),
    recoveryRequestCodeEmailLimiter: createRateLimiter(TEST_WINDOW_MS, HIGH_LIMIT),
    recoveryRequestCodeGlobalLimiter: createRateLimiter(TEST_WINDOW_MS, HIGH_LIMIT),
    recoveryVerifyCodeIpLimiter: createRateLimiter(TEST_WINDOW_MS, HIGH_LIMIT),
    keyRecoveryRequestMinResponseTimeMs: RESPONSE_FLOOR_MS,
    sendKeyRecoveryCodeEmail: async () => {
      await delay(SIMULATED_MAIL_LATENCY_MS);
    },
  });
  const server = app.listen(0);
  try {
    const t0 = Date.now();
    await postJson(server, '/api/recovery/request-code', { email: store.email });
    const registeredElapsed = Date.now() - t0;

    const t1 = Date.now();
    await postJson(server, '/api/recovery/request-code', { email: 'timing-unregistered@example.com' });
    const unregisteredElapsed = Date.now() - t1;

    // 両方とも下限(floor)以上の時間がかかっている。
    assert.ok(registeredElapsed >= RESPONSE_FLOOR_MS - 20, `registeredElapsed=${registeredElapsed}`);
    assert.ok(unregisteredElapsed >= RESPONSE_FLOOR_MS - 20, `unregisteredElapsed=${unregisteredElapsed}`);
    // メール送信の往復(120ms)がそのまま応答時間差として漏れていないことを確認する。
    // パディングが無ければ差はおよそSIMULATED_MAIL_LATENCY_MS(120ms)前後になるはずだが、
    // パディングが機能していれば両方ともfloor付近に揃い、差は十分小さくなる。
    const diff = Math.abs(registeredElapsed - unregisteredElapsed);
    assert.ok(diff < SIMULATED_MAIL_LATENCY_MS, `応答時間の差が大きすぎる(diff=${diff}ms)。列挙攻撃の手がかりになりうる`);
  } finally {
    server.close();
  }
});

// ============================================================
// 【中-4是正・AC-KF4】padUntilは「下限」であって「固定」ではない。Resendの応答が
// 下限(本番は400ms)を超えると、登録済み側だけが必ず遅くなりタイミング差が復活する
// （既存のAC-K6・タイミングのテストは SIMULATED_MAIL_LATENCY_MS(120ms) < floor(200ms)
// と、下限を超えない条件しか試しておらず、この穴を検出できなかった）。
// 根本策として、メール送信を応答後の非同期処理にした。このテストはメール送信の遅延が
// 下限を明確に超える設定にし、それでも応答時間には影響しないこと（＝メール送信を待たずに
// 応答が返ること）を直接検証する。
// ============================================================
test('正常系(AC-KF4・中-4是正): メール送信がpadUntilの下限を超えて遅れても、応答時間には影響しない（応答後に非同期送信する）', async () => {
  const store = makeStore({ email: 'timing-over-floor@example.com' });
  const { supabase } = createFakeSupabase({ stores: [store] });
  // 下限(RESPONSE_FLOOR_MS)よりも明確に大きい遅延をメール送信に仕込む。
  // 応答が送信を待ってしまう実装(mutation)だと、応答時間はこの値以上になるはず。
  const SIMULATED_MAIL_LATENCY_MS = 300;
  const RESPONSE_FLOOR_MS = 50;
  let emailSent = false;
  const app = buildApp({
    supabase,
    recoveryRequestCodeIpLimiter: createRateLimiter(TEST_WINDOW_MS, HIGH_LIMIT),
    recoveryRequestCodeEmailLimiter: createRateLimiter(TEST_WINDOW_MS, HIGH_LIMIT),
    recoveryRequestCodeGlobalLimiter: createRateLimiter(TEST_WINDOW_MS, HIGH_LIMIT),
    recoveryVerifyCodeIpLimiter: createRateLimiter(TEST_WINDOW_MS, HIGH_LIMIT),
    keyRecoveryRequestMinResponseTimeMs: RESPONSE_FLOOR_MS,
    sendKeyRecoveryCodeEmail: async () => {
      await delay(SIMULATED_MAIL_LATENCY_MS);
      emailSent = true;
    },
  });
  const server = app.listen(0);
  try {
    const t0 = Date.now();
    const res = await postJson(server, '/api/recovery/request-code', { email: store.email });
    const elapsed = Date.now() - t0;

    assert.strictEqual(res.status, 200);
    // 【核心1】応答はメール送信の遅延(300ms)を待たずに返る。応答が送信をawaitしていれば
    // elapsedは300ms以上になるはずだが、ここでは下限(50ms)付近で返るはず。
    assert.ok(
      elapsed < SIMULATED_MAIL_LATENCY_MS,
      `応答がメール送信の遅延を含んでしまっている(elapsed=${elapsed}ms >= ${SIMULATED_MAIL_LATENCY_MS}ms)`
    );
    // 【核心2】応答が返ってきた時点では、まだメール送信は完了していない（応答後に送信するため）。
    assert.strictEqual(emailSent, false, 'この時点ではまだメール送信が完了していないはず（応答後に非同期で送信されるため）');

    // メール送信自体は、応答後に実際に行われる。
    await waitFor(() => emailSent, { timeoutMs: 2000 });
    assert.strictEqual(emailSent, true, 'メール送信は応答の後に実際に行われるべき');
  } finally {
    server.close();
  }
});

// ============================================================
// 【AC-KF5】メール送信（Resend APIへのfetch）が失敗しても、復旧要求の応答は変わらない
// （列挙対策の維持）。中-4是正でメール送信を応答後の非同期処理にしたことで、送信の失敗が
// 応答に混ざりようがなくなった（構造的に不可能になった）が、これを直接検証するテストが
// 無かったため追加する。あわせて、送信失敗を拾い損ねてunhandledRejectionにならないこと
// （＝.catch()が確実に付いていること）も確認する。これを怠ると、Resend側の障害・
// APIキー失効のたびにNode.jsプロセスがクラッシュしうる（Node18+の既定挙動では
// unhandledRejectionはプロセス終了につながる）。
// ============================================================
test('正常系(AC-KF5): メール送信が失敗(reject)しても、応答は200・通常の文言のまま変わらない', async () => {
  const store = makeStore({ email: 'send-fail-recovery@example.com' });
  const { supabase } = createFakeSupabase({ stores: [store] });
  const app = buildFastApp({
    supabase,
    sendKeyRecoveryCodeEmail: async () => {
      throw new Error('Resend API error: 500 simulated failure');
    },
  });
  const server = app.listen(0);
  try {
    const res = await postJson(server, '/api/recovery/request-code', { email: store.email });
    assert.strictEqual(res.status, 200);
    assert.match(res.body.message, /確認コードを送信しました/);
  } finally {
    server.close();
  }
});

test('正常系(AC-KF5・回帰防止): メール送信の失敗が、プロセスのunhandledRejectionとして漏れない（.catch()が付いていることの確認）', async () => {
  const store = makeStore({ email: 'send-fail-unhandled@example.com' });
  const { supabase } = createFakeSupabase({ stores: [store] });
  const app = buildFastApp({
    supabase,
    sendKeyRecoveryCodeEmail: async () => {
      throw new Error('Resend API error: 500 simulated failure');
    },
  });
  const server = app.listen(0);
  const unhandled = [];
  const onUnhandledRejection = (reason) => unhandled.push(reason);
  process.on('unhandledRejection', onUnhandledRejection);
  try {
    const res = await postJson(server, '/api/recovery/request-code', { email: store.email });
    assert.strictEqual(res.status, 200);
    // メール送信（応答後の非同期処理）が実際に走ってrejectするまで少し待つ。
    await delay(100);
    assert.deepStrictEqual(unhandled, [], 'メール送信の失敗がunhandledRejectionとして漏れている(.catch()漏れの疑い)');
  } finally {
    process.removeListener('unhandledRejection', onUnhandledRejection);
    server.close();
  }
});

// padUntil自体の単体テスト（AC-K6のタイミング対策の土台）。
test('正常系: padUntilは、経過時間がfloor未満なら残り時間だけ待つ', async () => {
  const startedAt = Date.now();
  await padUntil(startedAt, 50);
  const elapsed = Date.now() - startedAt;
  assert.ok(elapsed >= 40, `elapsed=${elapsed}`); // 多少のタイマー誤差を許容
});

test('異常系: padUntilは、既にfloorを超えていれば追加で待たない', async () => {
  const startedAt = Date.now() - 1000; // 1秒前から経過している体で計測開始
  const before = Date.now();
  await padUntil(startedAt, 50);
  const elapsed = Date.now() - before;
  assert.ok(elapsed < 30, `elapsed=${elapsed}`); // ほぼ即座に返るはず
});

// ============================================================
// AC-K7: コード送信要求にレート制限（IP・メール・グローバル）がかかっている
// ============================================================

test('正常系(AC-K7): 上限内であれば、確認コードの送信要求は正常に受理される', async () => {
  const store = makeStore({ email: 'rate-ok@example.com' });
  const { supabase } = createFakeSupabase({ stores: [store] });
  const app = buildApp({
    supabase,
    recoveryRequestCodeIpLimiter: createRateLimiter(TEST_WINDOW_MS, 5),
    recoveryRequestCodeEmailLimiter: createRateLimiter(TEST_WINDOW_MS, 5),
    recoveryRequestCodeGlobalLimiter: createRateLimiter(TEST_WINDOW_MS, 5),
    recoveryVerifyCodeIpLimiter: createRateLimiter(TEST_WINDOW_MS, HIGH_LIMIT),
    keyRecoveryRequestMinResponseTimeMs: 0,
    sendKeyRecoveryCodeEmail: async () => {},
  });
  const server = app.listen(0);
  try {
    const res = await postJson(server, '/api/recovery/request-code', { email: store.email });
    assert.strictEqual(res.status, 200);
  } finally {
    server.close();
  }
});

test('異常系(AC-K7): 同一IPからの送信要求がIP上限を超えると429になる', async () => {
  const store = makeStore({ email: 'rate-ip@example.com' });
  const { supabase } = createFakeSupabase({ stores: [store] });
  const IP_MAX = 3;
  const app = buildApp({
    supabase,
    recoveryRequestCodeIpLimiter: createRateLimiter(TEST_WINDOW_MS, IP_MAX),
    recoveryRequestCodeEmailLimiter: createRateLimiter(TEST_WINDOW_MS, HIGH_LIMIT),
    recoveryRequestCodeGlobalLimiter: createRateLimiter(TEST_WINDOW_MS, HIGH_LIMIT),
    recoveryVerifyCodeIpLimiter: createRateLimiter(TEST_WINDOW_MS, HIGH_LIMIT),
    keyRecoveryRequestMinResponseTimeMs: 0,
    sendKeyRecoveryCodeEmail: async () => {},
  });
  const server = app.listen(0);
  try {
    const results = [];
    // 同一IP・異なるメールアドレスに対しても、IP単位の上限には引っかかることを確認する。
    for (let i = 0; i < IP_MAX + 2; i++) {
      results.push(await postJson(server, '/api/recovery/request-code', { email: `rate-ip-${i}@example.com` }));
    }
    assert.strictEqual(results.filter((r) => r.status === 200).length, IP_MAX);
    assert.strictEqual(results.filter((r) => r.status === 429).length, 2);
  } finally {
    server.close();
  }
});

test('異常系(AC-K7): 同一メールアドレスへの送信要求がメール単位の上限を超えると429になる', async () => {
  const store = makeStore({ email: 'rate-email@example.com' });
  const { supabase } = createFakeSupabase({ stores: [store] });
  const EMAIL_MAX = 3;
  const app = buildApp({
    supabase,
    recoveryRequestCodeIpLimiter: createRateLimiter(TEST_WINDOW_MS, HIGH_LIMIT),
    recoveryRequestCodeEmailLimiter: createRateLimiter(TEST_WINDOW_MS, EMAIL_MAX),
    recoveryRequestCodeGlobalLimiter: createRateLimiter(TEST_WINDOW_MS, HIGH_LIMIT),
    recoveryVerifyCodeIpLimiter: createRateLimiter(TEST_WINDOW_MS, HIGH_LIMIT),
    keyRecoveryRequestMinResponseTimeMs: 0,
    sendKeyRecoveryCodeEmail: async () => {},
  });
  const server = app.listen(0);
  try {
    const results = [];
    for (let i = 0; i < EMAIL_MAX + 2; i++) {
      results.push(await postJson(server, '/api/recovery/request-code', { email: store.email }));
    }
    assert.strictEqual(results.filter((r) => r.status === 200).length, EMAIL_MAX);
    assert.strictEqual(results.filter((r) => r.status === 429).length, 2);
  } finally {
    server.close();
  }
});

test('異常系(AC-K7): サービス全体のグローバル送信上限を超えると429になる', async () => {
  const stores = Array.from({ length: 5 }, (_, i) => makeStore({ email: `rate-global-${i}@example.com` }));
  const { supabase } = createFakeSupabase({ stores });
  const GLOBAL_MAX = 3;
  const app = buildApp({
    supabase,
    recoveryRequestCodeIpLimiter: createRateLimiter(TEST_WINDOW_MS, HIGH_LIMIT),
    recoveryRequestCodeEmailLimiter: createRateLimiter(TEST_WINDOW_MS, HIGH_LIMIT),
    recoveryRequestCodeGlobalLimiter: createRateLimiter(TEST_WINDOW_MS, GLOBAL_MAX),
    recoveryVerifyCodeIpLimiter: createRateLimiter(TEST_WINDOW_MS, HIGH_LIMIT),
    keyRecoveryRequestMinResponseTimeMs: 0,
    sendKeyRecoveryCodeEmail: async () => {},
  });
  const server = app.listen(0);
  try {
    const results = [];
    for (const s of stores) {
      results.push(await postJson(server, '/api/recovery/request-code', { email: s.email }));
    }
    assert.strictEqual(results.filter((r) => r.status === 200).length, GLOBAL_MAX);
    assert.strictEqual(results.filter((r) => r.status === 429).length, 2);
  } finally {
    server.close();
  }
});

test('異常系(AC-K7): 確認コード検証（verify-code）の試行も、同一IPからの回数に上限がある', async () => {
  const store = makeStore({ email: 'rate-verify-ip@example.com' });
  const { supabase } = createFakeSupabase({ stores: [store] });
  const IP_MAX = 3;
  const app = buildApp({
    supabase,
    recoveryRequestCodeIpLimiter: createRateLimiter(TEST_WINDOW_MS, HIGH_LIMIT),
    recoveryRequestCodeEmailLimiter: createRateLimiter(TEST_WINDOW_MS, HIGH_LIMIT),
    recoveryRequestCodeGlobalLimiter: createRateLimiter(TEST_WINDOW_MS, HIGH_LIMIT),
    recoveryVerifyCodeIpLimiter: createRateLimiter(TEST_WINDOW_MS, IP_MAX),
    keyRecoveryVerifyMinResponseTimeMs: 0,
    keyRecoveryRequestMinResponseTimeMs: 0,
    sendKeyRecoveryCodeEmail: async () => {},
  });
  const server = app.listen(0);
  try {
    await postJson(server, '/api/recovery/request-code', { email: store.email });
    const results = [];
    for (let i = 0; i < IP_MAX + 2; i++) {
      results.push(await postJson(server, '/api/recovery/verify-code', { email: store.email, code: '000000' }));
    }
    assert.strictEqual(results.filter((r) => r.status === 429).length, 2);
    assert.strictEqual(results.filter((r) => r.status === 400).length, IP_MAX);
  } finally {
    server.close();
  }
});

// ============================================================
// 設計検証：requestとverifyで、同じメールアドレスから同じ店舗を決定的に選ぶ
// （店舗が複数あってもねじれない）。stores.emailに一意制約が無いため、
// このテーブル設計上あり得るケースとして直接単体レベルで確認しておく。
// ============================================================

test('正常系: 同一メールアドレスが複数店舗に紐づく場合でも、requestとverifyは同じ店舗（最新の作成日時）を一貫して選ぶ', async () => {
  const sharedEmail = 'shared-email@example.com';
  const older = makeStore({ id: 'store-older', email: sharedEmail, created_at: '2020-01-01T00:00:00.000Z' });
  const newer = makeStore({ id: 'store-newer', email: sharedEmail, created_at: '2025-01-01T00:00:00.000Z' });
  const { supabase } = createFakeSupabase({ stores: [older, newer] });

  const code = '246810';
  const { storeId } = await requestKeyRecoveryCode({ supabase, email: sharedEmail, codeHash: hashKey(code), expiresAt: FUTURE });
  assert.strictEqual(storeId, 'store-newer');

  const result = await verifyKeyRecoveryCode({ supabase, email: sharedEmail, code, hashCode: hashKey, maxAttempts: KEY_RECOVERY_CODE_MAX_ATTEMPTS });
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.storeId, 'store-newer');
});

// ============================================================
// 【中-1是正・AC-KF1・低-6是正】PL/pgSQLの静的検証：RETURNS TABLEのOUTパラメータ名が、
// 同じ関数内のON CONFLICT句の推定列名と衝突していないか。
//
// 【背景】PostgreSQLの実装上、RETURNS TABLE (col uuid, ...) はplpgsqlの変数を作る。
// ON CONFLICT (列名) の列名は「ただの列名」ではなく、パーサ内部でColumnRefに変換され
// transformExpr()に通される（＝式として解決される）。そのため、テーブルの実列名と
// 同名のOUTパラメータがあると、既定の plpgsql.variable_conflict=error のもとで
// 「column reference is ambiguous」（SQLSTATE 42702）になる。
// INSERTの列リスト側は式として解決されないため安全で、ON CONFLICT句だけがこの罠にかかる
// （中-1で実際に踏んだ罠）。
//
// サンドボックスにPostgreSQLを導入できないため、実際に42702が起きるかどうかは
// 未検証（実機でのみ確認可能）。ここでは正規表現によるテキスト検証で、同じ罠が
// 将来のRPC変更・追加で再発しないことを機械的に担保する（監査人の低-6是正の提案に基づく）。
// ============================================================
test('静的検証(AC-KF1・中-1是正): setup.sqlの全RPCで、RETURNS TABLEのOUTパラメータ名がON CONFLICTの推定列名と衝突していない', () => {
  const sql = fs.readFileSync(path.join(__dirname, '..', 'supabase', 'setup.sql'), 'utf8');

  // "create or replace function ... $$;" というブロック単位で関数を抽出する
  // （関数名も一緒に取得し、報告に使う）。
  const funcBlocks = [...sql.matchAll(/create or replace function\s+(\w+)\([^]*?\n\$\$;/g)].map((m) => ({
    name: m[1],
    body: m[0],
  }));
  assert.ok(funcBlocks.length > 0, '関数定義が1つも見つからない(正規表現が壊れている可能性)');

  let onConflictChecked = 0;
  const checkedFunctions = [];
  for (const { name, body } of funcBlocks) {
    const ret = body.match(/returns table\s*\(([^)]*)\)/i);
    checkedFunctions.push(name);
    if (!ret) continue; // RETURNS TABLEを使っていない関数はこの罠と無関係
    const outNames = ret[1]
      .split(',')
      .map((s) => s.trim().split(/\s+/)[0].toLowerCase())
      .filter(Boolean);

    for (const m of body.matchAll(/on conflict\s*\(\s*([a-zA-Z0-9_]+)\s*\)/gi)) {
      onConflictChecked++;
      const col = m[1].toLowerCase();
      assert.ok(
        !outNames.includes(col),
        `関数 ${name}: ON CONFLICT (${m[1]}) がRETURNS TABLEのOUTパラメータ名(${outNames.join(', ')})と衝突している` +
          '（実行時に42702「column reference is ambiguous」になる。中-1と同じ罠）'
      );
    }
  }

  // このテスト自体が空振りしていない（=本当にON CONFLICTを含むRPCを検査した）ことを確認する。
  // request_key_recovery_codeのON CONFLICT (store_id)が対象になっているはず。
  assert.ok(
    checkedFunctions.includes('request_key_recovery_code'),
    'request_key_recovery_codeの検出に失敗している(正規表現の見直しが必要)'
  );
  assert.ok(onConflictChecked >= 1, 'ON CONFLICTを含むRPCが1つも検査されていない(テストが空振りしている)');
});

// 【AC-KF2】上のAC-KF1のテストは「RETURNS TABLEのOUTパラメータ名とON CONFLICTの推定列名」
// という中-1と同種の衝突だけを機械的に検出する。それ以外の統計（該当箇所が無いこと）は
// 開発担当が両RPCの全SQL文を1文ずつ目視で確認し、完了報告に一覧として記載する
// （consume_key_recovery_attemptはON CONFLICTを持たず、テーブル列への参照はすべて
// エイリアスkで修飾されているため、この種の衝突が原理的に起こらない）。
