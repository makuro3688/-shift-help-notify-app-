'use strict';

// 時間帯責任者への確定通知（/api/me/email/*、および確定時の宛先決定）の受け入れ条件を検証する。
//
// 【背景】確定通知の宛先は stores.email（オーナー）1つだけだった。しかし実際に
// 代理募集を送るのは時間帯責任者であることが多く、その人に結果が届かないと
// 「自分が送った募集の結果を、自分で確認できない」状態になっていた。
//
// 対象の受け入れ条件（AC-S1〜S13）：
//   AC-S1:  時間帯責任者が送った募集の確定で、オーナーと本人の両方に届く
//   AC-S2:  オーナーが送った募集の確定では、オーナーにだけ届く
//   AC-S3:  送信者が未登録なら、オーナーにだけ届く（エラーにしない）
//   AC-S4:  他の時間帯責任者には届かない（★特に重要）
//   AC-S5:  オーナーと同じアドレスなら、メールは1通だけ（重複除去）
//   AC-S6:  他人の通知先を書き換えられない（★特に重要）
//   AC-S7:  オーナーは /api/me/email/* を使えない（403）（★特に重要・乗っ取り防止）
//   AC-S8:  /api/me が役割ごとに正しいアドレスを返す（test/filledMailAddress.test.js）
//   AC-S9:  1通の送信失敗が、他の宛先への送信を止めない
//   AC-S10: 既存テストが壊れていない（`npm test` 全体で検証）
//   AC-S11: コードが一致しないと登録されない／5回間違えると失効する／期限切れは通らない
//   AC-S12: オーナーの一覧に登録状況が出る。ただしアドレス自体は返さない（★特に重要）
//   AC-S13: 確認コードの送信にレート制限がかかっている（スパム中継対策）
//
// 他のテストファイルと同じ方針で、server.jsが実際に構築するExpressアプリ（buildApp()）を
// そのまま使い、supabaseとメール送信関数だけをoverridesで差し替える。
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const http = require('node:http');
const {
  findEmailIssue,
  SUPERVISOR_EMAIL_CODE_MAX_ATTEMPTS,
} = require('../lib/supervisorEmail');

if (!process.env.RESEND_API_KEY) {
  process.env.RESEND_API_KEY = 'test-dummy-resend-api-key';
}
const { buildApp } = require('../server');

function hashKey(key) {
  return crypto.createHash('sha256').update(key).digest('hex');
}
function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
function waitFor(conditionFn, { timeoutMs = 1000, intervalMs = 5 } = {}) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    (function check() {
      if (conditionFn()) return resolve();
      if (Date.now() > deadline) return reject(new Error('waitFor: タイムアウト'));
      setTimeout(check, intervalMs);
    })();
  });
}
function request(server, method, path, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const { port } = server.address();
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        method,
        path,
        headers: {
          ...(payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {}),
          ...headers,
        },
      },
      (res) => {
        let raw = '';
        res.on('data', (c) => (raw += c));
        res.on('end', () => {
          let parsed = {};
          try {
            parsed = JSON.parse(raw || '{}');
          } catch (e) {
            parsed = { _raw: raw };
          }
          resolve({ status: res.statusCode, body: parsed });
        });
      }
    );
    req.on('error', reject);
    req.end(payload);
  });
}

// ============================================================
// フェイクSupabase
// stores / supervisor_keys / shifts / subscriptions と、
// RPC consume_supervisor_email_code の挙動（setup.sqlの実装と同じ判定順序）を模す。
// ============================================================
function createFakeSupabase({ stores = [], supervisorKeys = [], shifts = [], subscriptions = [] } = {}) {
  const storesArr = stores.map((s) => ({ ...s }));
  const supervisorKeysArr = supervisorKeys.map((s) => ({ pending_email_attempts: 0, ...s }));
  const shiftsArr = shifts.map((s) => ({ ...s }));
  const subscriptionsArr = subscriptions.map((s) => ({ ...s }));

  function chain(rows) {
    return {
      eq(col, val) {
        return chain(rows.filter((r) => r[col] === val));
      },
      order() {
        return chain(rows);
      },
      maybeSingle() {
        return Promise.resolve({ data: rows[0] ? { ...rows[0] } : null, error: null });
      },
      then(resolve, reject) {
        return Promise.resolve({ data: rows.map((r) => ({ ...r })), error: null }).then(resolve, reject);
      },
    };
  }

  function updater(arr) {
    return (payload) => {
      let matched = arr;
      const c = {
        eq(col, val) {
          matched = matched.filter((r) => r[col] === val);
          return c;
        },
        then(resolve, reject) {
          matched.forEach((r) => Object.assign(r, payload));
          return Promise.resolve({ data: null, error: null }).then(resolve, reject);
        },
      };
      return c;
    };
  }

  const supabase = {
    storesArr,
    supervisorKeysArr,
    shiftsArr,
    subscriptionsArr,
    rpcCalls: [],
    from(table) {
      if (table === 'stores') return { select: () => chain(storesArr) };
      if (table === 'supervisor_keys') {
        return {
          select: () => chain(supervisorKeysArr),
          update: updater(supervisorKeysArr),
          insert(row) {
            const created = { id: `sk-${supervisorKeysArr.length + 1}`, pending_email_attempts: 0, ...row };
            supervisorKeysArr.push(created);
            return {
              select: () => ({ single: () => Promise.resolve({ data: { ...created }, error: null }) }),
            };
          },
        };
      }
      if (table === 'shifts') {
        return {
          select: () => chain(shiftsArr),
          insert(row) {
            const created = { id: `shift-${shiftsArr.length + 1}`, status: 'open', ...row };
            shiftsArr.push(created);
            return {
              select: () => ({ single: () => Promise.resolve({ data: { ...created }, error: null }) }),
            };
          },
          update(payload) {
            let matched = shiftsArr;
            const c = {
              eq(col, val) {
                matched = matched.filter((r) => r[col] === val);
                return c;
              },
              select: () => ({
                maybeSingle: () => {
                  if (matched.length === 1) {
                    Object.assign(matched[0], payload);
                    return Promise.resolve({ data: { ...matched[0] }, error: null });
                  }
                  return Promise.resolve({ data: null, error: null });
                },
              }),
            };
            return c;
          },
        };
      }
      if (table === 'subscriptions') {
        return {
          select: () => chain(subscriptionsArr),
          delete: () => ({ in: () => Promise.resolve({ data: null, error: null }) }),
        };
      }
      throw new Error(`想定外のテーブルアクセス: ${table}`);
    },

    // supabase/setup.sql の consume_supervisor_email_code と同じ判定順序を再現する。
    // 【重要】ここを実装と食い違わせると、テストが通っても本番で動かない。
    // 判定順序：試行枠の消費 → 定数時間比較 → 一致時のみ昇格（1回限り）
    async rpc(name, params) {
      supabase.rpcCalls.push({ name, params });
      if (name !== 'consume_supervisor_email_code') {
        throw new Error(`想定外のRPC: ${name}`);
      }
      const row = supervisorKeysArr.find((s) => s.id === params.p_supervisor_id);
      const expired = !row || !row.pending_email_expires_at || new Date(row.pending_email_expires_at) <= new Date();
      if (!row || !row.pending_email || expired || (row.pending_email_attempts || 0) >= params.p_max) {
        return { data: [{ out_email: null, out_matched: false }], error: null };
      }
      // 枠を1つ消費してから照合する（照合を先にすると試し放題になる）
      row.pending_email_attempts = (row.pending_email_attempts || 0) + 1;
      if (row.pending_email_code_hash !== params.p_code_hash) {
        return { data: [{ out_email: null, out_matched: false }], error: null };
      }
      row.email = row.pending_email;
      row.pending_email = null;
      row.pending_email_code_hash = null;
      row.pending_email_expires_at = null;
      row.pending_email_attempts = 0;
      return { data: [{ out_email: row.email, out_matched: true }], error: null };
    },
  };
  return supabase;
}

// ============================================================
// 共通フィクスチャ
// ============================================================
const OWNER_KEY = 'owner-key-supervisor-email-test';
const SUP_KEY = 'supervisor-key-supervisor-email-test';
const SUP2_KEY = 'supervisor2-key-supervisor-email-test';

const BASE_STORE = {
  id: 'store-1',
  name: '渋谷店',
  email: 'owner@example.com',
  admin_key_hash: hashKey(OWNER_KEY),
  created_at: new Date().toISOString(),
  subscription_status: 'trial',
};
function makeSupervisor(overrides = {}) {
  return {
    id: 'sk-1',
    store_id: 'store-1',
    admin_key_hash: hashKey(SUP_KEY),
    label: '土曜夜担当',
    email: null,
    pending_email: null,
    pending_email_code_hash: null,
    pending_email_expires_at: null,
    pending_email_attempts: 0,
    created_at: new Date().toISOString(),
    ...overrides,
  };
}
// /api/shift/:id/respond は「その店舗に登録されている名前か」を subscriptions で確認する。
// 確定まで進めるテストには、必ずこのスタッフ購読が必要。
const BASE_STAFF = {
  id: 'sub-1',
  endpoint: 'https://push.example.com/staff-1',
  subscription: { endpoint: 'https://push.example.com/staff-1', keys: { p256dh: 'x', auth: 'y' } },
  store_id: 'store-1',
  store_name: '渋谷店',
  staff_name: '山田太郎',
  registered_at: new Date().toISOString(),
};

const BASE_SHIFT = {
  id: 'shift-1',
  store_id: 'store-1',
  store_name: '渋谷店',
  date: '2026-08-25',
  time: '18:00〜22:00',
  note: '',
  status: 'open',
  filled_by: null,
  filled_at: null,
  created_by_supervisor_id: null,
  created_at: new Date().toISOString(),
};

// メール送信を記録するアプリを作る。プッシュ送信は常に無効化する（本テストの対象外）。
function buildTestApp({ supabase, emailFn, codeEmailFn, overrides = {} } = {}) {
  const filledEmails = [];
  const codeEmails = [];
  const app = buildApp({
    supabase,
    sendPushNotification: async () => {},
    sendShiftFilledNotificationEmail:
      emailFn ||
      (async (args) => {
        filledEmails.push(args);
      }),
    sendSupervisorEmailCodeEmail:
      codeEmailFn ||
      (async (email, code, storeName) => {
        codeEmails.push({ email, code, storeName });
      }),
    // 【重要】レート制限器はモジュールスコープで、同じプロセス内の全テストで共有される。
    // 既定のままだと、テストを1つ増やしただけで別のテストが429で落ちるようになり、
    // 「何を検証しているテストなのか」と無関係な理由で赤くなる。
    // ここでは既定を「常に許可」に差し替え、レート制限そのものを検証するテスト
    // （AC-S13）だけが明示的に制限する形にする。
    supervisorEmailRequestLimiter: () => true,
    supervisorEmailRequestGlobalLimiter: () => true,
    supervisorEmailVerifyLimiter: () => true,
    ...overrides,
  });
  return { app, filledEmails, codeEmails };
}

// 確認コードを実際に送って登録まで済ませるヘルパー。
async function registerSupervisorEmail(server, codeEmails, adminKey, email) {
  const r1 = await request(server, 'POST', '/api/me/email/request-code', { email }, { 'x-admin-key': adminKey });
  assert.strictEqual(r1.status, 200, `request-code が失敗: ${JSON.stringify(r1.body)}`);
  const sent = codeEmails[codeEmails.length - 1];
  const r2 = await request(
    server,
    'POST',
    '/api/me/email/verify-code',
    { code: sent.code },
    { 'x-admin-key': adminKey }
  );
  assert.strictEqual(r2.status, 200, `verify-code が失敗: ${JSON.stringify(r2.body)}`);
  return r2.body.email;
}

// ============================================================
// AC-S7（★特に重要）: オーナーは /api/me/email/* を使えない
// ============================================================

test('異常系(AC-S7・核心): オーナーは確認コードを要求できない（403）', async () => {
  const supabase = createFakeSupabase({ stores: [BASE_STORE], supervisorKeys: [makeSupervisor()], subscriptions: [BASE_STAFF] });
  const { app, codeEmails } = buildTestApp({ supabase });
  const server = app.listen(0);
  try {
    const res = await request(
      server,
      'POST',
      '/api/me/email/request-code',
      { email: 'attacker@example.com' },
      { 'x-admin-key': OWNER_KEY }
    );
    assert.strictEqual(res.status, 403);
    assert.strictEqual(codeEmails.length, 0, 'メールを送ってはいけない');
    // stores.email が書き換わっていないこと（乗っ取りの本丸）。
    assert.strictEqual(supabase.storesArr[0].email, 'owner@example.com');
  } finally {
    server.close();
  }
});

test('異常系(AC-S7・核心): オーナーは通知先を解除できない（403）', async () => {
  const supabase = createFakeSupabase({ stores: [BASE_STORE], supervisorKeys: [makeSupervisor()], subscriptions: [BASE_STAFF] });
  const { app } = buildTestApp({ supabase });
  const server = app.listen(0);
  try {
    const res = await request(server, 'DELETE', '/api/me/email', undefined, { 'x-admin-key': OWNER_KEY });
    assert.strictEqual(res.status, 403);
    assert.strictEqual(supabase.storesArr[0].email, 'owner@example.com', 'stores.emailは消えてはいけない');
  } finally {
    server.close();
  }
});

test('異常系(AC-S7): 管理者キーが無ければ401（403より前に認証で弾かれる）', async () => {
  const supabase = createFakeSupabase({ stores: [BASE_STORE], supervisorKeys: [makeSupervisor()], subscriptions: [BASE_STAFF] });
  const { app, codeEmails } = buildTestApp({ supabase });
  const server = app.listen(0);
  try {
    const res = await request(server, 'POST', '/api/me/email/request-code', { email: 'x@example.com' });
    assert.strictEqual(res.status, 401);
    assert.strictEqual(codeEmails.length, 0);
  } finally {
    server.close();
  }
});

// ============================================================
// AC-S11: 確認コードによる検証
// ============================================================

test('正常系(AC-S11): 確認コードを正しく入力すると、通知先として登録される', async () => {
  const supabase = createFakeSupabase({ stores: [BASE_STORE], supervisorKeys: [makeSupervisor()], subscriptions: [BASE_STAFF] });
  const { app, codeEmails } = buildTestApp({ supabase });
  const server = app.listen(0);
  try {
    const res = await request(
      server,
      'POST',
      '/api/me/email/request-code',
      { email: 'sup@example.com' },
      { 'x-admin-key': SUP_KEY }
    );
    assert.strictEqual(res.status, 200);
    assert.strictEqual(codeEmails.length, 1);
    assert.strictEqual(codeEmails[0].email, 'sup@example.com');
    assert.match(codeEmails[0].code, /^\d{6}$/);
    assert.strictEqual(codeEmails[0].storeName, '渋谷店');

    // この時点ではまだ登録されていない（保留中）。
    assert.strictEqual(supabase.supervisorKeysArr[0].email, null, 'コード入力前に登録されてはいけない');

    const res2 = await request(
      server,
      'POST',
      '/api/me/email/verify-code',
      { code: codeEmails[0].code },
      { 'x-admin-key': SUP_KEY }
    );
    assert.strictEqual(res2.status, 200);
    assert.strictEqual(res2.body.email, 'sup@example.com');
    assert.strictEqual(supabase.supervisorKeysArr[0].email, 'sup@example.com');
    assert.strictEqual(supabase.supervisorKeysArr[0].pending_email, null, '保留状態は消えるはず');
  } finally {
    server.close();
  }
});

test('異常系(AC-S11・核心): コードが違うと登録されない', async () => {
  const supabase = createFakeSupabase({ stores: [BASE_STORE], supervisorKeys: [makeSupervisor()], subscriptions: [BASE_STAFF] });
  const { app, codeEmails } = buildTestApp({ supabase });
  const server = app.listen(0);
  try {
    await request(
      server,
      'POST',
      '/api/me/email/request-code',
      { email: 'sup@example.com' },
      { 'x-admin-key': SUP_KEY }
    );
    const wrong = codeEmails[0].code === '000000' ? '111111' : '000000';
    const res = await request(server, 'POST', '/api/me/email/verify-code', { code: wrong }, { 'x-admin-key': SUP_KEY });
    assert.strictEqual(res.status, 400);
    assert.strictEqual(supabase.supervisorKeysArr[0].email, null, '間違ったコードで登録されてはいけない');
  } finally {
    server.close();
  }
});

test('異常系(AC-S11・核心): 同じコードは2回使えない（1回限り）', async () => {
  const supabase = createFakeSupabase({ stores: [BASE_STORE], supervisorKeys: [makeSupervisor()], subscriptions: [BASE_STAFF] });
  const { app, codeEmails } = buildTestApp({ supabase });
  const server = app.listen(0);
  try {
    await request(
      server,
      'POST',
      '/api/me/email/request-code',
      { email: 'sup@example.com' },
      { 'x-admin-key': SUP_KEY }
    );
    const code = codeEmails[0].code;
    const first = await request(server, 'POST', '/api/me/email/verify-code', { code }, { 'x-admin-key': SUP_KEY });
    assert.strictEqual(first.status, 200);

    // 1度使ったコードで、解除後にもう一度登録できてしまわないこと。
    await request(server, 'DELETE', '/api/me/email', undefined, { 'x-admin-key': SUP_KEY });
    const second = await request(server, 'POST', '/api/me/email/verify-code', { code }, { 'x-admin-key': SUP_KEY });
    assert.strictEqual(second.status, 400, '使用済みのコードは通ってはいけない');
    assert.strictEqual(supabase.supervisorKeysArr[0].email, null);
  } finally {
    server.close();
  }
});

test(`異常系(AC-S11・核心): ${SUPERVISOR_EMAIL_CODE_MAX_ATTEMPTS}回間違えると、その後は正しいコードでも通らない`, async () => {
  const supabase = createFakeSupabase({ stores: [BASE_STORE], supervisorKeys: [makeSupervisor()], subscriptions: [BASE_STAFF] });
  const { app, codeEmails } = buildTestApp({ supabase });
  const server = app.listen(0);
  try {
    await request(
      server,
      'POST',
      '/api/me/email/request-code',
      { email: 'sup@example.com' },
      { 'x-admin-key': SUP_KEY }
    );
    const correct = codeEmails[0].code;
    const wrong = correct === '000000' ? '111111' : '000000';

    for (let i = 0; i < SUPERVISOR_EMAIL_CODE_MAX_ATTEMPTS; i++) {
      const r = await request(server, 'POST', '/api/me/email/verify-code', { code: wrong }, { 'x-admin-key': SUP_KEY });
      assert.strictEqual(r.status, 400);
    }
    const afterLimit = await request(
      server,
      'POST',
      '/api/me/email/verify-code',
      { code: correct },
      { 'x-admin-key': SUP_KEY }
    );
    assert.strictEqual(afterLimit.status, 400, '上限到達後は正しいコードでも通ってはいけない');
    assert.strictEqual(supabase.supervisorKeysArr[0].email, null);
  } finally {
    server.close();
  }
});

test('異常系(AC-S11): 期限切れのコードは通らない', async () => {
  const supabase = createFakeSupabase({
    stores: [BASE_STORE],
    supervisorKeys: [
      makeSupervisor({
        pending_email: 'sup@example.com',
        pending_email_code_hash: hashKey('123456'),
        pending_email_expires_at: new Date(Date.now() - 1000).toISOString(), // 1秒前に失効
      }),
    ],
    subscriptions: [BASE_STAFF],
  });
  const { app } = buildTestApp({ supabase });
  const server = app.listen(0);
  try {
    const res = await request(
      server,
      'POST',
      '/api/me/email/verify-code',
      { code: '123456' },
      { 'x-admin-key': SUP_KEY }
    );
    assert.strictEqual(res.status, 400);
    assert.strictEqual(supabase.supervisorKeysArr[0].email, null);
  } finally {
    server.close();
  }
});

test('正常系(AC-S11): コードを再送すると、試行回数が0に戻る（打ち間違えた人が締め出されない）', async () => {
  const supabase = createFakeSupabase({ stores: [BASE_STORE], supervisorKeys: [makeSupervisor()], subscriptions: [BASE_STAFF] });
  const { app, codeEmails } = buildTestApp({ supabase });
  const server = app.listen(0);
  try {
    await request(
      server,
      'POST',
      '/api/me/email/request-code',
      { email: 'sup@example.com' },
      { 'x-admin-key': SUP_KEY }
    );
    const wrong = codeEmails[0].code === '000000' ? '111111' : '000000';
    for (let i = 0; i < SUPERVISOR_EMAIL_CODE_MAX_ATTEMPTS; i++) {
      await request(server, 'POST', '/api/me/email/verify-code', { code: wrong }, { 'x-admin-key': SUP_KEY });
    }
    // 出し直す
    await request(
      server,
      'POST',
      '/api/me/email/request-code',
      { email: 'sup@example.com' },
      { 'x-admin-key': SUP_KEY }
    );
    const fresh = codeEmails[codeEmails.length - 1].code;
    const res = await request(server, 'POST', '/api/me/email/verify-code', { code: fresh }, { 'x-admin-key': SUP_KEY });
    assert.strictEqual(res.status, 200, '再送後は登録できるはず（上限が持ち越されてはいけない）');
  } finally {
    server.close();
  }
});

// ============================================================
// AC-S6（★特に重要）: 他人の通知先を書き換えられない
// ============================================================

test('異常系(AC-S6・核心): リクエストボディにIDを混ぜても、書き換わるのは自分の行だけ', async () => {
  const sup1 = makeSupervisor({ id: 'sk-1', label: '本人' });
  const sup2 = makeSupervisor({ id: 'sk-2', label: '他人', admin_key_hash: hashKey(SUP2_KEY) });
  const supabase = createFakeSupabase({ stores: [BASE_STORE], supervisorKeys: [sup1, sup2], subscriptions: [BASE_STAFF] });
  const { app, codeEmails } = buildTestApp({ supabase });
  const server = app.listen(0);
  try {
    // 他人のIDを詐称して送る
    const r1 = await request(
      server,
      'POST',
      '/api/me/email/request-code',
      { email: 'attacker@example.com', supervisorId: 'sk-2', id: 'sk-2' },
      { 'x-admin-key': SUP_KEY }
    );
    assert.strictEqual(r1.status, 200);
    await request(
      server,
      'POST',
      '/api/me/email/verify-code',
      { code: codeEmails[0].code, supervisorId: 'sk-2', id: 'sk-2' },
      { 'x-admin-key': SUP_KEY }
    );

    const target = supabase.supervisorKeysArr.find((s) => s.id === 'sk-2');
    const self = supabase.supervisorKeysArr.find((s) => s.id === 'sk-1');
    assert.strictEqual(target.email, null, '他人の通知先が書き換わってはいけない');
    assert.strictEqual(target.pending_email, null, '他人の保留状態も作られてはいけない');
    assert.strictEqual(self.email, 'attacker@example.com', '書き換わるのは自分の行だけ');
  } finally {
    server.close();
  }
});

test('異常系(AC-S6・核心): 失効済み（存在しない）キーでは何も操作できない', async () => {
  const supabase = createFakeSupabase({ stores: [BASE_STORE], supervisorKeys: [makeSupervisor()], subscriptions: [BASE_STAFF] });
  const { app, codeEmails } = buildTestApp({ supabase });
  const server = app.listen(0);
  try {
    const res = await request(
      server,
      'POST',
      '/api/me/email/request-code',
      { email: 'x@example.com' },
      { 'x-admin-key': 'revoked-key-that-does-not-exist' }
    );
    assert.strictEqual(res.status, 401);
    assert.strictEqual(codeEmails.length, 0);
  } finally {
    server.close();
  }
});

// ============================================================
// AC-S13: 確認コード送信のレート制限（スパム中継対策）
// ============================================================

test('異常系(AC-S13・核心): 確認コードの送信要求が上限を超えると429になり、メールも送られない', async () => {
  const supabase = createFakeSupabase({ stores: [BASE_STORE], supervisorKeys: [makeSupervisor()], subscriptions: [BASE_STAFF] });
  let allowed = 2;
  const { app, codeEmails } = buildTestApp({
    supabase,
    overrides: {
      supervisorEmailRequestLimiter: () => {
        if (allowed <= 0) return false;
        allowed -= 1;
        return true;
      },
    },
  });
  const server = app.listen(0);
  try {
    for (let i = 0; i < 2; i++) {
      const r = await request(
        server,
        'POST',
        '/api/me/email/request-code',
        { email: `a${i}@example.com` },
        { 'x-admin-key': SUP_KEY }
      );
      assert.strictEqual(r.status, 200);
    }
    const blocked = await request(
      server,
      'POST',
      '/api/me/email/request-code',
      { email: 'spam@example.com' },
      { 'x-admin-key': SUP_KEY }
    );
    assert.strictEqual(blocked.status, 429);
    assert.strictEqual(codeEmails.length, 2, '上限超過時はメールを送ってはいけない');
    assert.ok(
      !codeEmails.some((c) => c.email === 'spam@example.com'),
      '拒否した宛先にメールが飛んではいけない'
    );
  } finally {
    server.close();
  }
});

test('異常系(AC-S13): サービス全体の上限に達した場合も429（1人あたりの上限を回避されない）', async () => {
  const supabase = createFakeSupabase({ stores: [BASE_STORE], supervisorKeys: [makeSupervisor()], subscriptions: [BASE_STAFF] });
  const { app, codeEmails } = buildTestApp({
    supabase,
    overrides: { supervisorEmailRequestGlobalLimiter: () => false },
  });
  const server = app.listen(0);
  try {
    const res = await request(
      server,
      'POST',
      '/api/me/email/request-code',
      { email: 'x@example.com' },
      { 'x-admin-key': SUP_KEY }
    );
    assert.strictEqual(res.status, 429);
    assert.strictEqual(codeEmails.length, 0);
  } finally {
    server.close();
  }
});

test('異常系(AC-S13): 形式が明らかにおかしいアドレスは、メールを送る前に弾く', async () => {
  const supabase = createFakeSupabase({ stores: [BASE_STORE], supervisorKeys: [makeSupervisor()], subscriptions: [BASE_STAFF] });
  const { app, codeEmails } = buildTestApp({ supabase });
  const server = app.listen(0);
  try {
    for (const bad of ['', 'not-an-email', 'a@b', 'a b@example.com', 'a@example.com\nbcc:x@y.com']) {
      const res = await request(
        server,
        'POST',
        '/api/me/email/request-code',
        { email: bad },
        { 'x-admin-key': SUP_KEY }
      );
      assert.strictEqual(res.status, 400, `弾かれるべき: ${JSON.stringify(bad)}`);
    }
    assert.strictEqual(codeEmails.length, 0);
  } finally {
    server.close();
  }
});

test('単体(AC-S13): findEmailIssue は改行入りを拒否する（ヘッダインジェクションの多層防御）', () => {
  assert.ok(findEmailIssue('a@example.com\nbcc: x@y.com'));
  assert.ok(findEmailIssue('a@example.com\r\nbcc: x@y.com'));
  assert.strictEqual(findEmailIssue('taro@example.com'), null);
  assert.ok(findEmailIssue('a'.repeat(250) + '@example.com'), '長すぎるアドレスは拒否');
});

// ============================================================
// AC-S1〜S5・S9: 確定時の宛先
// ============================================================

// 代理募集を送って、そのIDを返すヘルパー。
async function sendBroadcast(server, adminKey) {
  const res = await request(
    server,
    'POST',
    '/api/send-broadcast',
    { date: '2026-08-25', time: '18:00〜22:00', note: '' },
    { 'x-admin-key': adminKey }
  );
  assert.strictEqual(res.status, 200, `send-broadcast が失敗: ${JSON.stringify(res.body)}`);
  return res.body;
}

test('正常系(AC-S1・核心): 時間帯責任者が送った募集が確定すると、オーナーと本人の両方に届く', async () => {
  const supabase = createFakeSupabase({
    stores: [BASE_STORE],
    supervisorKeys: [makeSupervisor()],
    subscriptions: [BASE_STAFF],
  });
  const { app, filledEmails, codeEmails } = buildTestApp({ supabase });
  const server = app.listen(0);
  try {
    await registerSupervisorEmail(server, codeEmails, SUP_KEY, 'sup@example.com');
    await sendBroadcast(server, SUP_KEY);
    const shift = supabase.shiftsArr[supabase.shiftsArr.length - 1];
    assert.strictEqual(shift.created_by_supervisor_id, 'sk-1', '送信者が記録されているはず');

    const res = await request(server, 'POST', `/api/shift/${shift.id}/respond`, { name: '山田太郎' });
    assert.strictEqual(res.status, 200);
    await waitFor(() => filledEmails.length === 2);

    const addresses = filledEmails.map((e) => e.storeEmail).sort();
    assert.deepStrictEqual(addresses, ['owner@example.com', 'sup@example.com']);
    // 内容は両者とも同じ（誰が入るかが分かる）
    for (const e of filledEmails) {
      assert.strictEqual(e.filledBy, '山田太郎');
      assert.strictEqual(e.storeName, '渋谷店');
    }
  } finally {
    server.close();
  }
});

test('正常系(AC-S2): オーナーが送った募集が確定すると、オーナーにだけ届く', async () => {
  const supabase = createFakeSupabase({ stores: [BASE_STORE], supervisorKeys: [makeSupervisor()], subscriptions: [BASE_STAFF] });
  const { app, filledEmails, codeEmails } = buildTestApp({ supabase });
  const server = app.listen(0);
  try {
    // 時間帯責任者は登録済みだが、この募集を送ったのはオーナー。
    await registerSupervisorEmail(server, codeEmails, SUP_KEY, 'sup@example.com');
    await sendBroadcast(server, OWNER_KEY);
    const shift = supabase.shiftsArr[supabase.shiftsArr.length - 1];
    assert.strictEqual(shift.created_by_supervisor_id, null, 'オーナーが送った場合はnull');

    const res = await request(server, 'POST', `/api/shift/${shift.id}/respond`, { name: '山田太郎' });
    assert.strictEqual(res.status, 200);
    await waitFor(() => filledEmails.length === 1);
    await delay(50);

    assert.strictEqual(filledEmails.length, 1);
    assert.strictEqual(filledEmails[0].storeEmail, 'owner@example.com');
  } finally {
    server.close();
  }
});

test('正常系(AC-S3): 送信した時間帯責任者が通知先を未登録なら、オーナーにだけ届く（エラーにならない）', async () => {
  const supabase = createFakeSupabase({ stores: [BASE_STORE], supervisorKeys: [makeSupervisor()], subscriptions: [BASE_STAFF] });
  const { app, filledEmails } = buildTestApp({ supabase });
  const server = app.listen(0);
  try {
    await sendBroadcast(server, SUP_KEY);
    const shift = supabase.shiftsArr[supabase.shiftsArr.length - 1];

    const res = await request(server, 'POST', `/api/shift/${shift.id}/respond`, { name: '山田太郎' });
    assert.strictEqual(res.status, 200);
    await waitFor(() => filledEmails.length === 1);
    await delay(50);

    assert.strictEqual(filledEmails.length, 1);
    assert.strictEqual(filledEmails[0].storeEmail, 'owner@example.com');
  } finally {
    server.close();
  }
});

test('異常系(AC-S4・核心): 他の時間帯責任者には届かない（送った本人だけ）', async () => {
  const sup1 = makeSupervisor({ id: 'sk-1', label: '送った人' });
  const sup2 = makeSupervisor({ id: 'sk-2', label: '送っていない人', admin_key_hash: hashKey(SUP2_KEY) });
  const supabase = createFakeSupabase({ stores: [BASE_STORE], supervisorKeys: [sup1, sup2], subscriptions: [BASE_STAFF] });
  const { app, filledEmails, codeEmails } = buildTestApp({ supabase });
  const server = app.listen(0);
  try {
    await registerSupervisorEmail(server, codeEmails, SUP_KEY, 'sender@example.com');
    await registerSupervisorEmail(server, codeEmails, SUP2_KEY, 'bystander@example.com');

    await sendBroadcast(server, SUP_KEY);
    const shift = supabase.shiftsArr[supabase.shiftsArr.length - 1];
    const res = await request(server, 'POST', `/api/shift/${shift.id}/respond`, { name: '山田太郎' });
    assert.strictEqual(res.status, 200);
    await waitFor(() => filledEmails.length === 2);
    await delay(50);

    const addresses = filledEmails.map((e) => e.storeEmail);
    assert.ok(addresses.includes('owner@example.com'));
    assert.ok(addresses.includes('sender@example.com'));
    assert.ok(
      !addresses.includes('bystander@example.com'),
      '送っていない時間帯責任者に届いてはいけない（届くと、やがて全部読まれなくなる）'
    );
    assert.strictEqual(filledEmails.length, 2);
  } finally {
    server.close();
  }
});

test('正常系(AC-S5・核心): オーナーと同じアドレスを登録していても、メールは1通だけ', async () => {
  const supabase = createFakeSupabase({ stores: [BASE_STORE], supervisorKeys: [makeSupervisor()], subscriptions: [BASE_STAFF] });
  const { app, filledEmails, codeEmails } = buildTestApp({ supabase });
  const server = app.listen(0);
  try {
    await registerSupervisorEmail(server, codeEmails, SUP_KEY, 'owner@example.com');
    await sendBroadcast(server, SUP_KEY);
    const shift = supabase.shiftsArr[supabase.shiftsArr.length - 1];

    const res = await request(server, 'POST', `/api/shift/${shift.id}/respond`, { name: '山田太郎' });
    assert.strictEqual(res.status, 200);
    await waitFor(() => filledEmails.length === 1);
    await delay(50);

    assert.strictEqual(filledEmails.length, 1, '同じ宛先に2通送ってはいけない（2件決まったと誤解される）');
  } finally {
    server.close();
  }
});

test('正常系(AC-S5): 大文字small文字の違いだけのアドレスも同一とみなして1通にする', async () => {
  const supabase = createFakeSupabase({ stores: [BASE_STORE], supervisorKeys: [makeSupervisor()], subscriptions: [BASE_STAFF] });
  const { app, filledEmails, codeEmails } = buildTestApp({ supabase });
  const server = app.listen(0);
  try {
    await registerSupervisorEmail(server, codeEmails, SUP_KEY, 'Owner@Example.com');
    await sendBroadcast(server, SUP_KEY);
    const shift = supabase.shiftsArr[supabase.shiftsArr.length - 1];

    const res = await request(server, 'POST', `/api/shift/${shift.id}/respond`, { name: '山田太郎' });
    assert.strictEqual(res.status, 200);
    await waitFor(() => filledEmails.length === 1);
    await delay(50);
    assert.strictEqual(filledEmails.length, 1);
  } finally {
    server.close();
  }
});

test('異常系(AC-S9・核心): オーナー宛の送信が失敗しても、時間帯責任者宛は送られる', async () => {
  const supabase = createFakeSupabase({ stores: [BASE_STORE], supervisorKeys: [makeSupervisor()], subscriptions: [BASE_STAFF] });
  const attempted = [];
  const { app, codeEmails } = buildTestApp({
    supabase,
    emailFn: async (args) => {
      attempted.push(args.storeEmail);
      if (args.storeEmail === 'owner@example.com') {
        throw new Error('送信失敗（模擬）');
      }
    },
  });
  const server = app.listen(0);
  try {
    await registerSupervisorEmail(server, codeEmails, SUP_KEY, 'sup@example.com');
    await sendBroadcast(server, SUP_KEY);
    const shift = supabase.shiftsArr[supabase.shiftsArr.length - 1];

    const res = await request(server, 'POST', `/api/shift/${shift.id}/respond`, { name: '山田太郎' });
    assert.strictEqual(res.status, 200);
    await waitFor(() => attempted.length === 2);

    assert.ok(attempted.includes('sup@example.com'), '1通目が失敗しても2通目は送られるはず');
  } finally {
    server.close();
  }
});

test('異常系(AC-S9): 確定通知メールが全て失敗しても、応募の応答は200のまま変わらない', async () => {
  const supabase = createFakeSupabase({ stores: [BASE_STORE], supervisorKeys: [makeSupervisor()], subscriptions: [BASE_STAFF] });
  const attempted = [];
  const { app, codeEmails } = buildTestApp({
    supabase,
    // 確定通知だけを失敗させる（確認コードのメールは別の関数なので成功したまま）。
    emailFn: async (args) => {
      attempted.push(args.storeEmail);
      throw new Error('送信失敗（模擬）');
    },
  });
  const server = app.listen(0);
  try {
    await registerSupervisorEmail(server, codeEmails, SUP_KEY, 'sup@example.com');
    await sendBroadcast(server, SUP_KEY);
    const shift = supabase.shiftsArr[supabase.shiftsArr.length - 1];

    const res = await request(server, 'POST', `/api/shift/${shift.id}/respond`, { name: '山田太郎' });
    // ★応募の確定はすでに成功しており、通知の失敗で「応募できなかった」ことにしてはいけない。
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.message, '応募が完了しました！ありがとうございます！');
    assert.strictEqual(shift.status, 'filled', '募集は確定したままのはず');

    // 2通とも試みられている（1通目の失敗で2通目が飛ばされていない）。
    await waitFor(() => attempted.length === 2);
  } finally {
    server.close();
  }
});

// ============================================================
// AC-S12（★特に重要）: オーナーの一覧に登録状況が出る。アドレスは返さない
// ============================================================

test('正常系(AC-S12・核心): 一覧には登録済みかどうかだけが出る。アドレスそのものは返らない', async () => {
  const sup1 = makeSupervisor({ id: 'sk-1', label: '登録済みの人', email: 'private@example.com' });
  const sup2 = makeSupervisor({ id: 'sk-2', label: '未登録の人', admin_key_hash: hashKey(SUP2_KEY) });
  const supabase = createFakeSupabase({ stores: [BASE_STORE], supervisorKeys: [sup1, sup2], subscriptions: [BASE_STAFF] });
  const { app } = buildTestApp({ supabase });
  const server = app.listen(0);
  try {
    const res = await request(server, 'GET', '/api/supervisors', undefined, { 'x-admin-key': OWNER_KEY });
    assert.strictEqual(res.status, 200);

    const byId = Object.fromEntries(res.body.map((s) => [s.id, s]));
    assert.strictEqual(byId['sk-1'].hasEmail, true);
    assert.strictEqual(byId['sk-2'].hasEmail, false);

    // ★アドレスそのものが漏れていないこと。オーナーが時間帯責任者の私用アドレスを
    // 一覧できると、本来の目的を超えた個人情報の収集になる。
    assert.ok(
      !JSON.stringify(res.body).includes('private@example.com'),
      '時間帯責任者のアドレスがオーナーに見えてはいけない'
    );
    assert.strictEqual(byId['sk-1'].email, undefined, 'email列をそのまま返してはいけない');
  } finally {
    server.close();
  }
});

test('異常系(AC-S12): 時間帯責任者は一覧を取得できない（オーナーのみ）', async () => {
  const supabase = createFakeSupabase({ stores: [BASE_STORE], supervisorKeys: [makeSupervisor()], subscriptions: [BASE_STAFF] });
  const { app } = buildTestApp({ supabase });
  const server = app.listen(0);
  try {
    const res = await request(server, 'GET', '/api/supervisors', undefined, { 'x-admin-key': SUP_KEY });
    assert.strictEqual(res.status, 403);
  } finally {
    server.close();
  }
});

// ============================================================
// 解除
// ============================================================

test('正常系: 通知先を解除すると、確定してもその人には届かなくなる', async () => {
  const supabase = createFakeSupabase({ stores: [BASE_STORE], supervisorKeys: [makeSupervisor()], subscriptions: [BASE_STAFF] });
  const { app, filledEmails, codeEmails } = buildTestApp({ supabase });
  const server = app.listen(0);
  try {
    await registerSupervisorEmail(server, codeEmails, SUP_KEY, 'sup@example.com');
    const del = await request(server, 'DELETE', '/api/me/email', undefined, { 'x-admin-key': SUP_KEY });
    assert.strictEqual(del.status, 200);

    await sendBroadcast(server, SUP_KEY);
    const shift = supabase.shiftsArr[supabase.shiftsArr.length - 1];
    const res = await request(server, 'POST', `/api/shift/${shift.id}/respond`, { name: '山田太郎' });
    assert.strictEqual(res.status, 200);
    await waitFor(() => filledEmails.length === 1);
    await delay(50);

    assert.strictEqual(filledEmails.length, 1);
    assert.strictEqual(filledEmails[0].storeEmail, 'owner@example.com');
  } finally {
    server.close();
  }
});
