'use strict';

// 代理出勤の確定通知の「宛先の案内」に関する検証。
//
// 【背景】店長への確定通知はプッシュではなくメール（stores.email宛）のみとした。
// そのため、店長が「どこに届くのか」を確認できる手段が無いと、通知が来ないときに
// 原因（宛先違い・迷惑メール）を切り分けられない。そこで、店長用ダッシュボードが
// 使う /api/me が宛先（email）を返すようにした。
//
// 対象の受け入れ条件（AC-M1〜AC-M5）：
//   AC-M1: /api/me が、ログイン中の店舗のメールアドレスを返す
//   AC-M2: メールアドレスが未設定（null）の店舗でも、/api/me は500にならずnullを返す
//   AC-M3: 管理者キーが無ければ /api/me は401で、メールアドレスは漏れない（★特に重要）
//   AC-M4: 他店舗のメールアドレスが返らない（キーに紐づく店舗のものだけ）（★特に重要）
//   AC-M5: emailはrequireAdminが取得済みのreq.storeから読む（追加のDB照会をしない）
//
// 画面側（manager.html の renderFilledMailAddress、signup.html の案内バナー）は
// ブラウザ上の表示であり、この自動テストの対象外。実機確認で担保する。
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const http = require('node:http');

// server.jsは他のテストファイルと同じく、requireより前にRESEND_API_KEYが必要。
if (!process.env.RESEND_API_KEY) {
  process.env.RESEND_API_KEY = 'test-dummy-resend-api-key';
}
const { buildApp } = require('../server');

function hashKey(key) {
  return crypto.createHash('sha256').update(key).digest('hex');
}

function getJson(server, path, headers = {}) {
  return new Promise((resolve, reject) => {
    const { port } = server.address();
    const req = http.request({ host: '127.0.0.1', port, method: 'GET', path, headers }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(body || '{}') }));
    });
    req.on('error', reject);
    req.end();
  });
}

// 【AC-M5】storesへのselect回数を数えるフェイク。requireAdminの分（2回：
// admin_key_hashでの照合と、店舗行の取得）を超えて増えていないことを確認するために使う。
function createFakeSupabase({ stores = [], supervisorKeys = [] } = {}) {
  const storesArr = stores.map((s) => ({ ...s }));
  const supervisorKeysArr = supervisorKeys.map((s) => ({ ...s }));
  const counts = { stores: 0, supervisor_keys: 0 };

  function chain(rows) {
    return {
      eq(col, val) {
        return chain(rows.filter((r) => r[col] === val));
      },
      maybeSingle() {
        return Promise.resolve({ data: rows[0] ? { ...rows[0] } : null, error: null });
      },
    };
  }

  return {
    counts,
    storesArr,
    from(table) {
      if (table === 'stores') {
        return {
          select() {
            counts.stores += 1;
            return chain(storesArr);
          },
        };
      }
      if (table === 'supervisor_keys') {
        return {
          select() {
            counts.supervisor_keys += 1;
            return chain(supervisorKeysArr);
          },
        };
      }
      throw new Error(`想定外のテーブルアクセス: ${table}`);
    },
  };
}

const OWNER_KEY = 'owner-key-for-filled-mail-test';
const SUPERVISOR_KEY = 'supervisor-key-for-filled-mail-test';

function makeStore(overrides = {}) {
  return {
    id: 'store-1',
    name: '渋谷店',
    email: 'owner@example.com',
    admin_key_hash: hashKey(OWNER_KEY),
    created_at: new Date().toISOString(),
    subscription_status: 'trial',
    ...overrides,
  };
}

// ============================================================
// AC-M1: /api/me がログイン中の店舗のメールアドレスを返す
// ============================================================

test('正常系(AC-M1): オーナーの管理者キーでログインすると、確定通知の宛先(email)が返る', async () => {
  const supabase = createFakeSupabase({ stores: [makeStore()] });
  const app = buildApp({ supabase });
  const server = app.listen(0);
  try {
    const res = await getJson(server, '/api/me', { 'x-admin-key': OWNER_KEY });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.email, 'owner@example.com');
    // 既存の項目が消えていないこと（画面はこれらで組み立てられている）。
    assert.strictEqual(res.body.storeId, 'store-1');
    assert.strictEqual(res.body.storeName, '渋谷店');
    assert.strictEqual(res.body.role, 'owner');
  } finally {
    server.close();
  }
});

test('正常系(AC-S8): 時間帯責任者には、自分が登録したアドレスが返る', async () => {
  const supabase = createFakeSupabase({
    stores: [makeStore()],
    supervisorKeys: [
      {
        id: 'sk-1',
        store_id: 'store-1',
        admin_key_hash: hashKey(SUPERVISOR_KEY),
        email: 'supervisor@example.com',
      },
    ],
  });
  const app = buildApp({ supabase });
  const server = app.listen(0);
  try {
    const res = await getJson(server, '/api/me', { 'x-admin-key': SUPERVISOR_KEY });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.role, 'supervisor');
    assert.strictEqual(res.body.email, 'supervisor@example.com');
    assert.strictEqual(res.body.canEditEmail, true, '時間帯責任者は自分の宛先を変更できる');
  } finally {
    server.close();
  }
});

test('異常系(AC-S8・核心): 時間帯責任者には、オーナーのアドレス(stores.email)を返さない', async () => {
  // 未登録の時間帯責任者。ここでオーナーのアドレスが漏れると、キーを預かっただけの人に
  // オーナー個人の連絡先を開示することになる。
  const supabase = createFakeSupabase({
    stores: [makeStore()],
    supervisorKeys: [{ id: 'sk-1', store_id: 'store-1', admin_key_hash: hashKey(SUPERVISOR_KEY) }],
  });
  const app = buildApp({ supabase });
  const server = app.listen(0);
  try {
    const res = await getJson(server, '/api/me', { 'x-admin-key': SUPERVISOR_KEY });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.email, null, '未登録ならnull。オーナーのアドレスで代用してはいけない');
    assert.ok(
      !JSON.stringify(res.body).includes('owner@example.com'),
      'オーナーのアドレスが応答のどこにも含まれてはいけない'
    );
  } finally {
    server.close();
  }
});

test('正常系(AC-S8): オーナーは canEditEmail が false（この画面からは変更できない）', async () => {
  const supabase = createFakeSupabase({ stores: [makeStore()] });
  const app = buildApp({ supabase });
  const server = app.listen(0);
  try {
    const res = await getJson(server, '/api/me', { 'x-admin-key': OWNER_KEY });
    assert.strictEqual(res.body.canEditEmail, false);
  } finally {
    server.close();
  }
});

// ============================================================
// AC-M2: メールアドレスが未設定でも500にならない
// ============================================================

test('異常系(AC-M2): stores.emailがnullでも、/api/meは200でemail:nullを返す', async () => {
  const supabase = createFakeSupabase({ stores: [makeStore({ email: null })] });
  const app = buildApp({ supabase });
  const server = app.listen(0);
  try {
    const res = await getJson(server, '/api/me', { 'x-admin-key': OWNER_KEY });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.email, null);
    assert.strictEqual(res.body.storeName, '渋谷店', 'emailが無くても店舗名の表示は巻き添えにならない');
  } finally {
    server.close();
  }
});

test('異常系(AC-M2): stores.emailが空文字でも、nullに正規化して返す（画面が「未設定」と案内できる）', async () => {
  const supabase = createFakeSupabase({ stores: [makeStore({ email: '' })] });
  const app = buildApp({ supabase });
  const server = app.listen(0);
  try {
    const res = await getJson(server, '/api/me', { 'x-admin-key': OWNER_KEY });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.email, null);
  } finally {
    server.close();
  }
});

// ============================================================
// AC-M3（★特に重要）: 認証なしではメールアドレスが漏れない
// ============================================================

test('異常系(AC-M3・核心): 管理者キーが無いと401で、応答にメールアドレスは含まれない', async () => {
  const supabase = createFakeSupabase({ stores: [makeStore()] });
  const app = buildApp({ supabase });
  const server = app.listen(0);
  try {
    const res = await getJson(server, '/api/me');
    assert.strictEqual(res.status, 401);
    assert.ok(!JSON.stringify(res.body).includes('owner@example.com'), 'メールアドレスが漏れてはいけない');
  } finally {
    server.close();
  }
});

test('異常系(AC-M3・核心): 誤った管理者キーでも401で、応答にメールアドレスは含まれない', async () => {
  const supabase = createFakeSupabase({ stores: [makeStore()] });
  const app = buildApp({ supabase });
  const server = app.listen(0);
  try {
    const res = await getJson(server, '/api/me', { 'x-admin-key': 'wrong-key' });
    assert.strictEqual(res.status, 401);
    assert.ok(!JSON.stringify(res.body).includes('owner@example.com'), 'メールアドレスが漏れてはいけない');
  } finally {
    server.close();
  }
});

// ============================================================
// AC-M4（★特に重要）: 他店舗のメールアドレスが返らない
// ============================================================

test('異常系(AC-M4・核心): 複数店舗があっても、返るのは自分のキーに紐づく店舗のemailだけ', async () => {
  const otherStore = makeStore({
    id: 'store-2',
    name: '新宿店',
    email: 'other-owner@example.com',
    admin_key_hash: hashKey('other-owner-key'),
  });
  const supabase = createFakeSupabase({ stores: [makeStore(), otherStore] });
  const app = buildApp({ supabase });
  const server = app.listen(0);
  try {
    const res = await getJson(server, '/api/me', { 'x-admin-key': OWNER_KEY });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.email, 'owner@example.com');
    assert.notStrictEqual(res.body.email, 'other-owner@example.com');

    const otherRes = await getJson(server, '/api/me', { 'x-admin-key': 'other-owner-key' });
    assert.strictEqual(otherRes.body.email, 'other-owner@example.com');
  } finally {
    server.close();
  }
});

// ============================================================
// AC-M5: emailのために追加のDB照会をしない
// ============================================================

test('正常系(AC-M5): emailを返すためにstoresへ追加のselectをしない（requireAdminの取得結果を使う）', async () => {
  const supabase = createFakeSupabase({ stores: [makeStore()] });
  const app = buildApp({ supabase });
  const server = app.listen(0);
  try {
    const res = await getJson(server, '/api/me', { 'x-admin-key': OWNER_KEY });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.email, 'owner@example.com');
    // requireAdminがstoresを見るのは2回（キー照合＋店舗行の取得）。
    // ハンドラ側で3回目を発行していたら、この検証で気づける。
    assert.strictEqual(supabase.counts.stores, 2, 'storesへのselectはrequireAdminの2回だけのはず');
  } finally {
    server.close();
  }
});
