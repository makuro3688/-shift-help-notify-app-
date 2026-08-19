'use strict';

// 確定通知の拡張：代打（欠員募集）の応募が確定したときに送る3方向のプッシュ通知の検証。
//   ①応募した本人へ（「あなたに決まりました」）
//   ②他のスタッフへ（「他の方に決まりました」）
//   ③店長へ（「代打が決まりました」。店長用ダッシュボード(manager.html)からの購読が必要）
//
// 【背景】直前のコミットで「代打が確定したら店長にメールを送る」機能を追加したが、
// 応募した本人は「あとで見返せる記録」を持てず、他のスタッフは通知を受けて開いたら
// 埋まっていた、という体験になっていた。「決まりました通知がないと現場としてわかりにくい」
// という指摘を受け、この3方向のプッシュ通知を追加する。
//
// 対象の受け入れ条件（完了報告のAC-P1〜AC-P12に対応）：
//   AC-P1: 応募した本人に「あなたに決まりました」が届く
//   AC-P2: 他のスタッフに「他の方に決まりました」が届く
//   AC-P3: ①と②の文面が異なる（★特に重要）
//   AC-P4: ②は震動しない設定で送られる（★特に重要）
//   AC-P5: 店長が通知を購読していれば、確定時にプッシュが届く
//   AC-P6: 店長には代理募集の通知が届かない（★特に重要）
//   AC-P7: endpointが送られてこない場合、全員に②が届く
//   AC-P8: 1人分の送信が失敗しても、他の人への送信が続行される（★特に重要）
//   AC-P9: 通知の失敗で応募の確定が失敗扱いにならない
//   AC-P10: 通知は応答を返した後に行われ、応答時間に影響しない
//   AC-P11: 先着で負けた応募では、これらの通知が送られない
//   AC-P12: 既存テスト・既存フローが壊れていないことは `npm test` 全体で検証する
//
// test/shiftNotification.test.js（店長へのメール通知）と同じ方針で、server.jsが実際に
// 構築するExpressアプリ（buildApp()）をそのまま使い、supabaseとプッシュ送信関数
// （sendPushNotification）だけをoverridesで差し替える。ハンドラ本体・判定順序は
// すべてserver.js本体のものを検証する。
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const http = require('node:http');

// server.jsは、requireするより前にRESEND_API_KEYが無いと店舗登録関連の一部処理が
// 500になる設計のため、他のテストファイルと同じくダミー値を設定しておく。
if (!process.env.RESEND_API_KEY) {
  process.env.RESEND_API_KEY = 'test-dummy-resend-api-key';
}
const { buildApp } = require('../server');

function hashKey(key) {
  return crypto.createHash('sha256').update(key).digest('hex');
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// 通知処理は応答後の非同期処理(setImmediate)のため、conditionFnがtrueになるまで
// 短い間隔でポーリングする（他のテストファイルと同じ手法）。
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

function postJson(server, path, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const { port } = server.address();
    const payload = JSON.stringify(body);
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        method: 'POST',
        path,
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload), ...headers },
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

// ============================================================
// フェイクSupabase：shifts・stores・subscriptions・manager_subscriptionsを模す。
// server.js本体が使う正確なメソッドチェーンだけをサポートする最小実装
// （test/shiftNotification.test.jsのフェイクと同じ設計方針）。
// ============================================================
function filterChain(rows) {
  return {
    eq(col, val) {
      return filterChain(rows.filter((r) => r[col] === val));
    },
    maybeSingle() {
      return Promise.resolve({ data: rows[0] ? { ...rows[0] } : null, error: null });
    },
    then(resolve, reject) {
      return Promise.resolve({ data: rows.map((r) => ({ ...r })), error: null }).then(resolve, reject);
    },
  };
}

function createFakeSupabase({ shifts = [], stores = [], subscriptions = [], managerSubscriptions = [] } = {}) {
  const shiftsArr = shifts.map((s) => ({ ...s }));
  const storesArr = stores.map((s) => ({ ...s }));
  const subscriptionsArr = subscriptions.map((s) => ({ ...s }));
  const managerSubscriptionsArr = managerSubscriptions.map((s) => ({ ...s }));

  const supabase = {
    shiftsArr,
    storesArr,
    subscriptionsArr,
    managerSubscriptionsArr,
    from(table) {
      if (table === 'shifts') {
        return {
          select() {
            return filterChain(shiftsArr);
          },
          // 先着順の再現：絞り込み後にちょうど1件残っていた場合だけmutateする
          // （test/shiftNotification.test.jsのフェイクと同じ実装）。
          update(payload) {
            let matched = shiftsArr;
            const chain = {
              eq(col, val) {
                matched = matched.filter((r) => r[col] === val);
                return chain;
              },
              select() {
                return {
                  maybeSingle() {
                    if (matched.length === 1) {
                      Object.assign(matched[0], payload);
                      return Promise.resolve({ data: { ...matched[0] }, error: null });
                    }
                    return Promise.resolve({ data: null, error: null });
                  },
                };
              },
            };
            return chain;
          },
        };
      }
      if (table === 'stores') {
        return {
          select() {
            return filterChain(storesArr);
          },
        };
      }
      if (table === 'subscriptions') {
        return {
          select() {
            return filterChain(subscriptionsArr);
          },
          delete() {
            return {
              in(col, vals) {
                const targets = new Set(vals);
                for (let i = subscriptionsArr.length - 1; i >= 0; i--) {
                  if (targets.has(subscriptionsArr[i][col])) subscriptionsArr.splice(i, 1);
                }
                return Promise.resolve({ data: null, error: null });
              },
            };
          },
        };
      }
      if (table === 'manager_subscriptions') {
        return {
          select() {
            return filterChain(managerSubscriptionsArr);
          },
          insert(row) {
            managerSubscriptionsArr.push({
              id: `mgrsub-${managerSubscriptionsArr.length + 1}`,
              registered_at: new Date().toISOString(),
              ...row,
            });
            return Promise.resolve({ data: null, error: null });
          },
          update(payload) {
            let matched = managerSubscriptionsArr;
            const chain = {
              eq(col, val) {
                matched = matched.filter((r) => r[col] === val);
                return chain;
              },
              then(resolve, reject) {
                matched.forEach((r) => Object.assign(r, payload));
                return Promise.resolve({ data: null, error: null }).then(resolve, reject);
              },
            };
            return chain;
          },
          delete() {
            return {
              in(col, vals) {
                const targets = new Set(vals);
                for (let i = managerSubscriptionsArr.length - 1; i >= 0; i--) {
                  if (targets.has(managerSubscriptionsArr[i][col])) managerSubscriptionsArr.splice(i, 1);
                }
                return Promise.resolve({ data: null, error: null });
              },
            };
          },
        };
      }
      throw new Error(`想定外のテーブルアクセス: ${table}`);
    },
  };
  return supabase;
}

// ============================================================
// 共通フィクスチャ
// ============================================================
const OWNER_ADMIN_KEY = 'owner-admin-key-for-push-test';
const BASE_STORE = {
  id: 'store-1',
  name: '渋谷店',
  email: 'owner@example.com',
  admin_key_hash: hashKey(OWNER_ADMIN_KEY),
  created_at: new Date().toISOString(),
  subscription_status: 'trial',
};
const BASE_SHIFT = {
  id: 'shift-1',
  store_id: 'store-1',
  store_name: '渋谷店',
  date: '2026-08-20',
  time: '18:00〜22:00',
  note: '',
  status: 'open',
  filled_by: null,
  filled_at: null,
  created_at: new Date().toISOString(),
};

function makeSub({ endpoint, staff_name, store_id = 'store-1' }) {
  return {
    id: `sub-${endpoint}`,
    endpoint,
    subscription: { endpoint, keys: { p256dh: 'dummy', auth: 'dummy' } },
    store_id,
    store_name: '渋谷店',
    staff_name,
    registered_at: new Date().toISOString(),
  };
}

// buildApp()を呼び、pushCallsに送信内容を記録するsendPushNotificationのフェイクを組み込む。
// failEndpoints: このendpointへの送信はエラーを投げる（Mapで {endpoint: errorオブジェクト} を指定可）。
function buildTestApp({ supabase, failEndpoints = {}, emailFn } = {}) {
  const pushCalls = [];
  const app = buildApp({
    supabase,
    sendShiftFilledNotificationEmail: emailFn || (async () => {}),
    sendPushNotification: async (subscription, payloadString) => {
      const endpoint = subscription && subscription.endpoint;
      const payload = JSON.parse(payloadString);
      pushCalls.push({ endpoint, payload });
      if (Object.prototype.hasOwnProperty.call(failEndpoints, endpoint)) {
        throw failEndpoints[endpoint];
      }
    },
  });
  return { app, pushCalls };
}

const PUSH_TITLE_ASSIGNED_TO_ME = '代打が確定しました';
const PUSH_TITLE_CLOSED_FOR_OTHERS = '募集は終了しました';
const PUSH_TITLE_MANAGER_FILLED = '代打が決まりました';

// ============================================================
// AC-P1: 応募が確定すると、応募した本人に「あなたに決まりました」が届く
// ============================================================

test('正常系(AC-P1): endpointが一致する本人には、①「代打が確定しました／あなたに決まりました」が届く', async () => {
  const winnerSub = makeSub({ endpoint: 'https://push.example.com/winner', staff_name: '山田太郎' });
  const otherSub = makeSub({ endpoint: 'https://push.example.com/other', staff_name: '鈴木花子' });
  const supabase = createFakeSupabase({ shifts: [BASE_SHIFT], stores: [BASE_STORE], subscriptions: [winnerSub, otherSub] });
  const { app, pushCalls } = buildTestApp({ supabase });
  const server = app.listen(0);
  try {
    const res = await postJson(server, `/api/shift/${BASE_SHIFT.id}/respond`, {
      name: '山田太郎',
      endpoint: winnerSub.endpoint,
    });
    assert.strictEqual(res.status, 200);
    await waitFor(() => pushCalls.length === 2);

    const toWinner = pushCalls.find((c) => c.endpoint === winnerSub.endpoint);
    assert.ok(toWinner, '本人の端末へ送信されているはず');
    assert.strictEqual(toWinner.payload.title, PUSH_TITLE_ASSIGNED_TO_ME);
    assert.strictEqual(toWinner.payload.body, '2026-08-20 18:00〜22:00 の代打はあなたに決まりました。よろしくお願いします。');
  } finally {
    server.close();
  }
});

test('異常系(AC-P1): 本人への送信自体が失敗しても、応募の応答は200のまま変わらない', async () => {
  const winnerSub = makeSub({ endpoint: 'https://push.example.com/winner-fail', staff_name: '山田太郎' });
  const supabase = createFakeSupabase({ shifts: [BASE_SHIFT], stores: [BASE_STORE], subscriptions: [winnerSub] });
  const { app, pushCalls } = buildTestApp({
    supabase,
    failEndpoints: { [winnerSub.endpoint]: new Error('send failed (simulated)') },
  });
  const server = app.listen(0);
  try {
    const res = await postJson(server, `/api/shift/${BASE_SHIFT.id}/respond`, {
      name: '山田太郎',
      endpoint: winnerSub.endpoint,
    });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.message, '応募が完了しました！ありがとうございます！');
    await waitFor(() => pushCalls.length === 1);
  } finally {
    server.close();
  }
});

// ============================================================
// AC-P2: 応募が確定すると、他のスタッフに「他の方に決まりました」が届く
// ============================================================

test('正常系(AC-P2): 本人以外のスタッフには②「募集は終了しました／他の方に決まりました」が届く', async () => {
  const winnerSub = makeSub({ endpoint: 'https://push.example.com/winner2', staff_name: '山田太郎' });
  const otherSub1 = makeSub({ endpoint: 'https://push.example.com/other2a', staff_name: '鈴木花子' });
  const otherSub2 = makeSub({ endpoint: 'https://push.example.com/other2b', staff_name: '佐藤次郎' });
  const supabase = createFakeSupabase({
    shifts: [BASE_SHIFT],
    stores: [BASE_STORE],
    subscriptions: [winnerSub, otherSub1, otherSub2],
  });
  const { app, pushCalls } = buildTestApp({ supabase });
  const server = app.listen(0);
  try {
    const res = await postJson(server, `/api/shift/${BASE_SHIFT.id}/respond`, {
      name: '山田太郎',
      endpoint: winnerSub.endpoint,
    });
    assert.strictEqual(res.status, 200);
    await waitFor(() => pushCalls.length === 3);

    for (const otherEndpoint of [otherSub1.endpoint, otherSub2.endpoint]) {
      const call = pushCalls.find((c) => c.endpoint === otherEndpoint);
      assert.ok(call, `${otherEndpoint} へ送信されているはず`);
      assert.strictEqual(call.payload.title, PUSH_TITLE_CLOSED_FOR_OTHERS);
      assert.strictEqual(call.payload.body, '2026-08-20 18:00〜22:00 の代打募集は、他の方に決まりました。');
    }
  } finally {
    server.close();
  }
});

test('異常系(AC-P2): 応募者本人しか購読していない場合、②は誰にも送られない（送信対象0件でもエラーにならない）', async () => {
  const winnerSub = makeSub({ endpoint: 'https://push.example.com/onlyone', staff_name: '山田太郎' });
  const supabase = createFakeSupabase({ shifts: [BASE_SHIFT], stores: [BASE_STORE], subscriptions: [winnerSub] });
  const { app, pushCalls } = buildTestApp({ supabase });
  const server = app.listen(0);
  try {
    const res = await postJson(server, `/api/shift/${BASE_SHIFT.id}/respond`, {
      name: '山田太郎',
      endpoint: winnerSub.endpoint,
    });
    assert.strictEqual(res.status, 200);
    await waitFor(() => pushCalls.length === 1);
    assert.strictEqual(pushCalls[0].payload.title, PUSH_TITLE_ASSIGNED_TO_ME);
    assert.ok(!pushCalls.some((c) => c.payload.title === PUSH_TITLE_CLOSED_FOR_OTHERS));
  } finally {
    server.close();
  }
});

// ============================================================
// AC-P3（最重要）: ①と②の文面が異なる（本人と他スタッフで内容が入れ替わらない）
// ============================================================

test('正常系(AC-P3・核心): ①（本人）と②（他スタッフ）の文面は同一ではなく、それぞれ主語が正しい', async () => {
  const winnerSub = makeSub({ endpoint: 'https://push.example.com/p3-winner', staff_name: '山田太郎' });
  const otherSub = makeSub({ endpoint: 'https://push.example.com/p3-other', staff_name: '鈴木花子' });
  const supabase = createFakeSupabase({
    shifts: [BASE_SHIFT],
    stores: [BASE_STORE],
    subscriptions: [winnerSub, otherSub],
  });
  const { app, pushCalls } = buildTestApp({ supabase });
  const server = app.listen(0);
  try {
    const res = await postJson(server, `/api/shift/${BASE_SHIFT.id}/respond`, {
      name: '山田太郎',
      endpoint: winnerSub.endpoint,
    });
    assert.strictEqual(res.status, 200);
    await waitFor(() => pushCalls.length === 2);

    const toWinner = pushCalls.find((c) => c.endpoint === winnerSub.endpoint);
    const toOther = pushCalls.find((c) => c.endpoint === otherSub.endpoint);

    // 【核心】タイトル・本文のどちらも、本人向けと他スタッフ向けで一致してはいけない。
    assert.notStrictEqual(toWinner.payload.title, toOther.payload.title);
    assert.notStrictEqual(toWinner.payload.body, toOther.payload.body);
    // 本人向けには「あなたに」、他スタッフ向けには「他の方に」という、主語を区別する
    // 文言がそれぞれ正しく入っていること（取り違えていないこと）を明示的に確認する。
    assert.match(toWinner.payload.body, /あなたに決まりました/);
    assert.doesNotMatch(toWinner.payload.body, /他の方に決まりました/);
    assert.match(toOther.payload.body, /他の方に決まりました/);
    assert.doesNotMatch(toOther.payload.body, /あなたに決まりました/);
  } finally {
    server.close();
  }
});

test('異常系(回帰防止・AC-P3): 応募者が変わっても、"あなたに決まりました"を受け取るのは常にendpointが一致した本人だけである', async () => {
  const subA = makeSub({ endpoint: 'https://push.example.com/p3b-a', staff_name: 'Aさん' });
  const subB = makeSub({ endpoint: 'https://push.example.com/p3b-b', staff_name: 'Bさん' });
  const supabase = createFakeSupabase({ shifts: [BASE_SHIFT], stores: [BASE_STORE], subscriptions: [subA, subB] });
  const { app, pushCalls } = buildTestApp({ supabase });
  const server = app.listen(0);
  try {
    // Bさんが応募して確定する（Aさんではない）。
    const res = await postJson(server, `/api/shift/${BASE_SHIFT.id}/respond`, {
      name: 'Bさん',
      endpoint: subB.endpoint,
    });
    assert.strictEqual(res.status, 200);
    await waitFor(() => pushCalls.length === 2);

    const toA = pushCalls.find((c) => c.endpoint === subA.endpoint);
    const toB = pushCalls.find((c) => c.endpoint === subB.endpoint);
    assert.strictEqual(toA.payload.title, PUSH_TITLE_CLOSED_FOR_OTHERS, 'Aさんは応募していないので②のはず');
    assert.strictEqual(toB.payload.title, PUSH_TITLE_ASSIGNED_TO_ME, 'Bさんが応募して確定したので①のはず');
  } finally {
    server.close();
  }
});

// ============================================================
// AC-P4（最重要）: ②は震動しない設定で送られる
// ============================================================

test('正常系(AC-P4・核心): ②（他の方に決まりました）は震動なし(vibrate: [])で送られる', async () => {
  const winnerSub = makeSub({ endpoint: 'https://push.example.com/p4-winner', staff_name: '山田太郎' });
  const otherSub = makeSub({ endpoint: 'https://push.example.com/p4-other', staff_name: '鈴木花子' });
  const supabase = createFakeSupabase({
    shifts: [BASE_SHIFT],
    stores: [BASE_STORE],
    subscriptions: [winnerSub, otherSub],
  });
  const { app, pushCalls } = buildTestApp({ supabase });
  const server = app.listen(0);
  try {
    const res = await postJson(server, `/api/shift/${BASE_SHIFT.id}/respond`, {
      name: '山田太郎',
      endpoint: winnerSub.endpoint,
    });
    assert.strictEqual(res.status, 200);
    await waitFor(() => pushCalls.length === 2);
    const toOther = pushCalls.find((c) => c.endpoint === otherSub.endpoint);
    assert.deepStrictEqual(toOther.payload.vibrate, []);
  } finally {
    server.close();
  }
});

test('異常系(回帰防止・AC-P4): ①（本人向け）は震動なし(空配列)ではない（②とだけ体感を分ける設計であることの確認）', async () => {
  const winnerSub = makeSub({ endpoint: 'https://push.example.com/p4b-winner', staff_name: '山田太郎' });
  const supabase = createFakeSupabase({ shifts: [BASE_SHIFT], stores: [BASE_STORE], subscriptions: [winnerSub] });
  const { app, pushCalls } = buildTestApp({ supabase });
  const server = app.listen(0);
  try {
    const res = await postJson(server, `/api/shift/${BASE_SHIFT.id}/respond`, {
      name: '山田太郎',
      endpoint: winnerSub.endpoint,
    });
    assert.strictEqual(res.status, 200);
    await waitFor(() => pushCalls.length === 1);
    assert.notDeepStrictEqual(pushCalls[0].payload.vibrate, []);
    assert.ok(Array.isArray(pushCalls[0].payload.vibrate) && pushCalls[0].payload.vibrate.length > 0);
  } finally {
    server.close();
  }
});

// ============================================================
// AC-P5: 店長が通知を購読していれば、確定時にプッシュが届く
// ============================================================

test('正常系(AC-P5): /api/manager-subscribeで購読した店長には、③「代打が決まりました」が届く', async () => {
  const applicantSub = makeSub({ endpoint: 'https://push.example.com/p5-applicant', staff_name: '山田太郎' });
  const supabase = createFakeSupabase({ shifts: [BASE_SHIFT], stores: [BASE_STORE], subscriptions: [applicantSub] });
  const { app, pushCalls } = buildTestApp({ supabase });
  const server = app.listen(0);
  try {
    const subRes = await postJson(
      server,
      '/api/manager-subscribe',
      { subscription: { endpoint: 'https://push.example.com/manager-1', keys: { p256dh: 'x', auth: 'y' } } },
      { 'x-admin-key': OWNER_ADMIN_KEY }
    );
    assert.strictEqual(subRes.status, 201);

    const res = await postJson(server, `/api/shift/${BASE_SHIFT.id}/respond`, { name: '山田太郎' });
    assert.strictEqual(res.status, 200);
    await waitFor(() => pushCalls.some((c) => c.endpoint === 'https://push.example.com/manager-1'));

    const toManager = pushCalls.find((c) => c.endpoint === 'https://push.example.com/manager-1');
    assert.strictEqual(toManager.payload.title, PUSH_TITLE_MANAGER_FILLED);
    assert.strictEqual(toManager.payload.body, '2026-08-20 18:00〜22:00 の代打に山田太郎さんが決まりました。');
  } finally {
    server.close();
  }
});

test('異常系(AC-P5): 店長が誰も購読していない場合でも、応募は成功しエラーにならない（送信対象0件）', async () => {
  const applicantSub = makeSub({ endpoint: 'https://push.example.com/p5b-applicant', staff_name: '山田太郎' });
  const supabase = createFakeSupabase({ shifts: [BASE_SHIFT], stores: [BASE_STORE], subscriptions: [applicantSub] });
  const { app, pushCalls } = buildTestApp({ supabase });
  const server = app.listen(0);
  try {
    const res = await postJson(server, `/api/shift/${BASE_SHIFT.id}/respond`, { name: '山田太郎' });
    assert.strictEqual(res.status, 200);
    await delay(50);
    assert.strictEqual(pushCalls.filter((c) => c.payload.title === PUSH_TITLE_MANAGER_FILLED).length, 0);
  } finally {
    server.close();
  }
});

// ============================================================
// AC-P6（最重要）: 店長には代理募集の通知が届かない（スタッフ向け配信に混ざっていない）
// ============================================================

test('正常系(AC-P6・核心): 店長の購読は、スタッフ向け配信リスト(subscriptions)には保存されない', async () => {
  const supabase = createFakeSupabase({ shifts: [BASE_SHIFT], stores: [BASE_STORE] });
  const { app } = buildTestApp({ supabase });
  const server = app.listen(0);
  try {
    const subRes = await postJson(
      server,
      '/api/manager-subscribe',
      { subscription: { endpoint: 'https://push.example.com/manager-2', keys: { p256dh: 'x', auth: 'y' } } },
      { 'x-admin-key': OWNER_ADMIN_KEY }
    );
    assert.strictEqual(subRes.status, 201);

    assert.strictEqual(supabase.subscriptionsArr.length, 0, 'subscriptions(スタッフ向け配信リスト)には何も保存されないはず');
    assert.strictEqual(supabase.managerSubscriptionsArr.length, 1, 'manager_subscriptionsに1件保存されるはず');
    assert.strictEqual(supabase.managerSubscriptionsArr[0].endpoint, 'https://push.example.com/manager-2');
  } finally {
    server.close();
  }
});

test('異常系(AC-P6・核心): 店長が購読していても、店長の端末には①②（スタッフ向けの文面）が一切届かない', async () => {
  const winnerSub = makeSub({ endpoint: 'https://push.example.com/p6-winner', staff_name: '山田太郎' });
  const otherSub = makeSub({ endpoint: 'https://push.example.com/p6-other', staff_name: '鈴木花子' });
  const supabase = createFakeSupabase({
    shifts: [BASE_SHIFT],
    stores: [BASE_STORE],
    subscriptions: [winnerSub, otherSub],
  });
  const { app, pushCalls } = buildTestApp({ supabase });
  const server = app.listen(0);
  try {
    const managerEndpoint = 'https://push.example.com/manager-3';
    await postJson(
      server,
      '/api/manager-subscribe',
      { subscription: { endpoint: managerEndpoint, keys: { p256dh: 'x', auth: 'y' } } },
      { 'x-admin-key': OWNER_ADMIN_KEY }
    );

    const res = await postJson(server, `/api/shift/${BASE_SHIFT.id}/respond`, {
      name: '山田太郎',
      endpoint: winnerSub.endpoint,
    });
    assert.strictEqual(res.status, 200);
    // 3件（本人・他スタッフ・店長）が送られるまで待つ。
    await waitFor(() => pushCalls.length === 3);

    const managerCalls = pushCalls.filter((c) => c.endpoint === managerEndpoint);
    assert.strictEqual(managerCalls.length, 1, '店長には1件だけ届くはず（確定通知のみ）');
    assert.strictEqual(managerCalls[0].payload.title, PUSH_TITLE_MANAGER_FILLED);
    assert.notStrictEqual(managerCalls[0].payload.title, PUSH_TITLE_ASSIGNED_TO_ME);
    assert.notStrictEqual(managerCalls[0].payload.title, PUSH_TITLE_CLOSED_FOR_OTHERS);

    // 逆方向の確認：スタッフ向けの2件(①②)の宛先に店長のendpointが紛れ込んでいないこと。
    const staffCalls = pushCalls.filter((c) => c.endpoint !== managerEndpoint);
    assert.strictEqual(staffCalls.length, 2);
    assert.ok(!staffCalls.some((c) => c.payload.title === PUSH_TITLE_MANAGER_FILLED));
  } finally {
    server.close();
  }
});

// ============================================================
// AC-P7: endpointが送られてこない場合、全員に②が届く
// ============================================================

test('正常系(AC-P7): endpointを送らずに応募すると、購読している全員に②が届く（本人にも①ではなく②）', async () => {
  const applicantSub = makeSub({ endpoint: 'https://push.example.com/p7-applicant', staff_name: '山田太郎' });
  const otherSub = makeSub({ endpoint: 'https://push.example.com/p7-other', staff_name: '鈴木花子' });
  const supabase = createFakeSupabase({
    shifts: [BASE_SHIFT],
    stores: [BASE_STORE],
    subscriptions: [applicantSub, otherSub],
  });
  const { app, pushCalls } = buildTestApp({ supabase });
  const server = app.listen(0);
  try {
    // endpointを含めずに応募する（respond.htmlが対応していない古い端末・キャッシュ等を想定）。
    const res = await postJson(server, `/api/shift/${BASE_SHIFT.id}/respond`, { name: '山田太郎' });
    assert.strictEqual(res.status, 200);
    await waitFor(() => pushCalls.length === 2);

    assert.ok(pushCalls.every((c) => c.payload.title === PUSH_TITLE_CLOSED_FOR_OTHERS), '全員に②が届くはず（①は誰にも届かない）');
    assert.ok(!pushCalls.some((c) => c.payload.title === PUSH_TITLE_ASSIGNED_TO_ME));
  } finally {
    server.close();
  }
});

test('異常系(AC-P7): endpointが送られてきても購読一覧の中に見当たらない場合も、全員に②が届く', async () => {
  const applicantSub = makeSub({ endpoint: 'https://push.example.com/p7b-applicant', staff_name: '山田太郎' });
  const otherSub = makeSub({ endpoint: 'https://push.example.com/p7b-other', staff_name: '鈴木花子' });
  const supabase = createFakeSupabase({
    shifts: [BASE_SHIFT],
    stores: [BASE_STORE],
    subscriptions: [applicantSub, otherSub],
  });
  const { app, pushCalls } = buildTestApp({ supabase });
  const server = app.listen(0);
  try {
    // 購読一覧に存在しない、ずれたendpointを送る（キャッシュ済みの古い購読情報などを想定）。
    const res = await postJson(server, `/api/shift/${BASE_SHIFT.id}/respond`, {
      name: '山田太郎',
      endpoint: 'https://push.example.com/does-not-exist-in-subscriptions',
    });
    assert.strictEqual(res.status, 200);
    await waitFor(() => pushCalls.length === 2);
    assert.ok(pushCalls.every((c) => c.payload.title === PUSH_TITLE_CLOSED_FOR_OTHERS));
  } finally {
    server.close();
  }
});

// ============================================================
// AC-P8（最重要）: 1人分の送信が失敗しても、他の人への送信が続行される
// ============================================================

test('正常系(AC-P8・核心): スタッフ向け送信で先頭の1件が失敗しても、残りの宛先には送信される', async () => {
  // failするsubscriptionを先頭に置く。もし実装がPromise.all+個別catchではなく、
  // 単純な逐次awaitループ（catch無し）に壊れていた場合、1件目の失敗でループが止まり、
  // 2件目・3件目が一切送信されなくなる（このテストが検出したい壊れ方）。
  const failingSub = makeSub({ endpoint: 'https://push.example.com/p8-fail', staff_name: '失効太郎' });
  const okSub1 = makeSub({ endpoint: 'https://push.example.com/p8-ok1', staff_name: '鈴木花子' });
  const okSub2 = makeSub({ endpoint: 'https://push.example.com/p8-ok2', staff_name: '佐藤次郎' });
  const supabase = createFakeSupabase({
    shifts: [BASE_SHIFT],
    stores: [BASE_STORE],
    subscriptions: [failingSub, okSub1, okSub2],
  });
  const staleError = new Error('Gone (simulated)');
  staleError.statusCode = 410;
  const { app, pushCalls } = buildTestApp({
    supabase,
    failEndpoints: { [failingSub.endpoint]: staleError },
  });
  const server = app.listen(0);
  try {
    const res = await postJson(server, `/api/shift/${BASE_SHIFT.id}/respond`, {
      name: '佐藤次郎',
      endpoint: okSub2.endpoint,
    });
    assert.strictEqual(res.status, 200);
    // 3件とも送信が「試みられる」ところまで待つ（失敗した1件も含む）。
    await waitFor(() => pushCalls.length === 3);

    assert.ok(pushCalls.some((c) => c.endpoint === okSub1.endpoint), '1件目が失敗しても2件目には届くはず');
    assert.ok(pushCalls.some((c) => c.endpoint === okSub2.endpoint), '1件目が失敗しても3件目（本人）には届くはず');

    // 副次的な確認：410（購読失効）を返した宛先は、購読一覧から自動的に片付けられる。
    await waitFor(() => !supabase.subscriptionsArr.some((s) => s.endpoint === failingSub.endpoint));
    assert.ok(supabase.subscriptionsArr.some((s) => s.endpoint === okSub1.endpoint), '失敗していない購読は残るはず');
  } finally {
    server.close();
  }
});

test('異常系(AC-P8): 店長側の送信でも、1件の失敗が他の店長端末への送信を止めない', async () => {
  const applicantSub = makeSub({ endpoint: 'https://push.example.com/p8b-applicant', staff_name: '山田太郎' });
  const supabase = createFakeSupabase({ shifts: [BASE_SHIFT], stores: [BASE_STORE], subscriptions: [applicantSub] });
  const failingManagerEndpoint = 'https://push.example.com/mgr-fail';
  const okManagerEndpoint = 'https://push.example.com/mgr-ok';
  const staleError = new Error('Not Found (simulated)');
  staleError.statusCode = 404;
  const { app, pushCalls } = buildTestApp({
    supabase,
    failEndpoints: { [failingManagerEndpoint]: staleError },
  });
  const server = app.listen(0);
  try {
    // failするほうを先に登録する（配列の先頭に来るようにする）。
    await postJson(
      server,
      '/api/manager-subscribe',
      { subscription: { endpoint: failingManagerEndpoint, keys: { p256dh: 'x', auth: 'y' } } },
      { 'x-admin-key': OWNER_ADMIN_KEY }
    );
    await postJson(
      server,
      '/api/manager-subscribe',
      { subscription: { endpoint: okManagerEndpoint, keys: { p256dh: 'x', auth: 'y' } } },
      { 'x-admin-key': OWNER_ADMIN_KEY }
    );

    const res = await postJson(server, `/api/shift/${BASE_SHIFT.id}/respond`, { name: '山田太郎' });
    assert.strictEqual(res.status, 200);
    await waitFor(() => pushCalls.some((c) => c.endpoint === okManagerEndpoint));
    assert.ok(pushCalls.some((c) => c.endpoint === failingManagerEndpoint));

    await waitFor(() => !supabase.managerSubscriptionsArr.some((s) => s.endpoint === failingManagerEndpoint));
    assert.ok(supabase.managerSubscriptionsArr.some((s) => s.endpoint === okManagerEndpoint));
  } finally {
    server.close();
  }
});

// ============================================================
// AC-P9: 通知の失敗で応募の確定が失敗扱いにならない
// ============================================================

test('正常系(AC-P9): メール・①②・③のすべてが失敗しても、応募の応答は200のまま変わらない', async () => {
  const winnerSub = makeSub({ endpoint: 'https://push.example.com/p9-winner', staff_name: '山田太郎' });
  const supabase = createFakeSupabase({ shifts: [BASE_SHIFT], stores: [BASE_STORE], subscriptions: [winnerSub] });
  const boom = new Error('boom');
  const { app, pushCalls } = buildTestApp({
    supabase,
    emailFn: async () => {
      throw new Error('mail boom');
    },
    failEndpoints: { [winnerSub.endpoint]: boom },
  });
  const server = app.listen(0);
  try {
    const res = await postJson(server, `/api/shift/${BASE_SHIFT.id}/respond`, {
      name: '山田太郎',
      endpoint: winnerSub.endpoint,
    });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.message, '応募が完了しました！ありがとうございます！');
    assert.strictEqual(supabase.shiftsArr[0].status, 'filled');
    await waitFor(() => pushCalls.length === 1);
  } finally {
    server.close();
  }
});

test('異常系(AC-P9・回帰防止): プッシュ通知の失敗がunhandledRejectionとして漏れない', async () => {
  const winnerSub = makeSub({ endpoint: 'https://push.example.com/p9b-winner', staff_name: '山田太郎' });
  const supabase = createFakeSupabase({ shifts: [BASE_SHIFT], stores: [BASE_STORE], subscriptions: [winnerSub] });
  const { app } = buildTestApp({
    supabase,
    failEndpoints: { [winnerSub.endpoint]: new Error('push boom') },
  });
  const server = app.listen(0);

  let unhandled = null;
  const onUnhandledRejection = (err) => {
    unhandled = err;
  };
  process.on('unhandledRejection', onUnhandledRejection);
  try {
    const res = await postJson(server, `/api/shift/${BASE_SHIFT.id}/respond`, {
      name: '山田太郎',
      endpoint: winnerSub.endpoint,
    });
    assert.strictEqual(res.status, 200);
    await delay(100);
    assert.strictEqual(unhandled, null, 'プッシュ通知の失敗がunhandledRejectionとして漏れてはいけない');
  } finally {
    process.off('unhandledRejection', onUnhandledRejection);
    server.close();
  }
});

// ============================================================
// AC-P10: 通知は応答を返した後に行われ、応答時間に影響しない
// ============================================================

test('正常系(AC-P10・核心): プッシュ送信に時間がかかっても、応募の応答はそれを待たずに返る', async () => {
  const shift = { ...BASE_SHIFT, id: 'shift-p10' };
  const winnerSub = makeSub({ endpoint: 'https://push.example.com/p10-winner', staff_name: '山田太郎', store_id: shift.store_id });
  const supabase = createFakeSupabase({ shifts: [shift], stores: [BASE_STORE], subscriptions: [winnerSub] });
  const SIMULATED_PUSH_LATENCY_MS = 300;
  let pushSent = false;
  const app = buildApp({
    supabase,
    sendShiftFilledNotificationEmail: async () => {},
    sendPushNotification: async () => {
      await delay(SIMULATED_PUSH_LATENCY_MS);
      pushSent = true;
    },
  });
  const server = app.listen(0);
  try {
    const t0 = Date.now();
    const res = await postJson(server, `/api/shift/${shift.id}/respond`, { name: '山田太郎', endpoint: winnerSub.endpoint });
    const elapsed = Date.now() - t0;

    assert.strictEqual(res.status, 200);
    assert.ok(elapsed < SIMULATED_PUSH_LATENCY_MS, `応答がプッシュ送信の遅延を含んでしまっている(elapsed=${elapsed}ms)`);
    assert.strictEqual(pushSent, false, 'この時点ではまだプッシュ送信が完了していないはず');

    await waitFor(() => pushSent, { timeoutMs: 2000 });
    assert.strictEqual(pushSent, true);
  } finally {
    server.close();
  }
});

test('異常系(AC-P10): 購読一覧の取得(DB照会)が遅くても、応募の応答はそれを待たずに返る', async () => {
  const shift = { ...BASE_SHIFT, id: 'shift-p10b' };
  const winnerSub = makeSub({ endpoint: 'https://push.example.com/p10b-winner', staff_name: '山田太郎', store_id: shift.store_id });
  const supabase = createFakeSupabase({ shifts: [shift], stores: [BASE_STORE], subscriptions: [winnerSub] });

  // subscriptionsテーブルへの select('*') （＝応答後のプッシュ送信対象を集める問い合わせ）
  // だけを遅延させる。select('staff_name') （＝応答前になりすまし防止のため名前を照合する
  // 問い合わせ）は遅延させない（そちらが遅いと応答そのものが遅れるのは当然であり、
  // このテストが検証したい「応答後のプッシュ関連DB照会が遅い」場合とは別の話のため）。
  const SIMULATED_DB_LATENCY_MS = 300;
  function wrapDelayed(node) {
    return {
      eq(col, val) {
        return wrapDelayed(node.eq(col, val));
      },
      maybeSingle() {
        return delay(SIMULATED_DB_LATENCY_MS).then(() => node.maybeSingle());
      },
      then(resolve, reject) {
        return delay(SIMULATED_DB_LATENCY_MS)
          .then(() => node)
          .then(resolve, reject);
      },
    };
  }
  const originalFrom = supabase.from.bind(supabase);
  supabase.from = (table) => {
    const real = originalFrom(table);
    if (table === 'subscriptions') {
      return {
        ...real,
        select(cols) {
          const node = real.select(cols);
          return cols === '*' ? wrapDelayed(node) : node;
        },
      };
    }
    return real;
  };

  let pushSent = false;
  const app = buildApp({
    supabase,
    sendShiftFilledNotificationEmail: async () => {},
    sendPushNotification: async () => {
      pushSent = true;
    },
  });
  const server = app.listen(0);
  try {
    const t0 = Date.now();
    const res = await postJson(server, `/api/shift/${shift.id}/respond`, { name: '山田太郎', endpoint: winnerSub.endpoint });
    const elapsed = Date.now() - t0;
    assert.strictEqual(res.status, 200);
    assert.ok(elapsed < SIMULATED_DB_LATENCY_MS, `応答がDB照会の遅延を含んでしまっている(elapsed=${elapsed}ms)`);
    assert.strictEqual(pushSent, false);

    await waitFor(() => pushSent, { timeoutMs: 2000 });
  } finally {
    server.close();
  }
});

// ============================================================
// AC-P11（最重要）: 先着で負けた応募では、これらの通知が送られない
// ============================================================

test('正常系(AC-P11・核心): 既に確定済みの募集へ応募（409）した場合、①②③のいずれも送られない', async () => {
  const alreadyFilledShift = {
    ...BASE_SHIFT,
    id: 'shift-p11-filled',
    status: 'filled',
    filled_by: '先に応募した人',
    filled_at: new Date().toISOString(),
  };
  const sub = makeSub({ endpoint: 'https://push.example.com/p11-late', staff_name: '後から来た人' });
  const supabase = createFakeSupabase({ shifts: [alreadyFilledShift], stores: [BASE_STORE], subscriptions: [sub] });
  const { app, pushCalls } = buildTestApp({ supabase });
  const server = app.listen(0);
  try {
    // 事前に店長を購読させておき、③も送られていないことを確認できるようにする。
    await postJson(
      server,
      '/api/manager-subscribe',
      { subscription: { endpoint: 'https://push.example.com/p11-manager', keys: { p256dh: 'x', auth: 'y' } } },
      { 'x-admin-key': OWNER_ADMIN_KEY }
    );

    const res = await postJson(server, `/api/shift/${alreadyFilledShift.id}/respond`, {
      name: '後から来た人',
      endpoint: sub.endpoint,
    });
    assert.strictEqual(res.status, 409);
    await delay(50);
    assert.strictEqual(pushCalls.length, 0, '先着で負けた場合はいずれの通知も送られないはず');
  } finally {
    server.close();
  }
});

test('異常系(AC-P11): 2人がほぼ同時に応募した場合でも、通知は先着で確定した1人分の①だけが送られる', async () => {
  const shift = { ...BASE_SHIFT, id: 'shift-p11-race' };
  const subA = makeSub({ endpoint: 'https://push.example.com/p11-race-a', staff_name: '早いAさん' });
  const subB = makeSub({ endpoint: 'https://push.example.com/p11-race-b', staff_name: '遅いBさん' });
  const supabase = createFakeSupabase({ shifts: [shift], stores: [BASE_STORE], subscriptions: [subA, subB] });
  const { app, pushCalls } = buildTestApp({ supabase });
  const server = app.listen(0);
  try {
    const [resA, resB] = await Promise.all([
      postJson(server, `/api/shift/${shift.id}/respond`, { name: '早いAさん', endpoint: subA.endpoint }),
      postJson(server, `/api/shift/${shift.id}/respond`, { name: '遅いBさん', endpoint: subB.endpoint }),
    ]);
    const statuses = [resA.status, resB.status].sort();
    assert.deepStrictEqual(statuses, [200, 409]);

    await waitFor(() => pushCalls.length === 2, { timeoutMs: 500 }).catch(() => {});
    await delay(50);
    assert.strictEqual(pushCalls.length, 2, '通知は先着で確定した1人分の①②（合計2件）だけが送られるはず');
    const assignedCalls = pushCalls.filter((c) => c.payload.title === PUSH_TITLE_ASSIGNED_TO_ME);
    assert.strictEqual(assignedCalls.length, 1, '①（あなたに決まりました）は1件だけのはず');
  } finally {
    server.close();
  }
});
