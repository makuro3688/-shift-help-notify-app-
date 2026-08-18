'use strict';

// 代打（欠員募集）の応募が確定したら、店舗のメールアドレス(stores.email)宛に通知メールを
// 送ることの検証。
//
// 対象の受け入れ条件（完了報告のAC-N1〜AC-N8に対応）：
//   AC-N1: 応募が確定すると、店舗のメールアドレス宛に通知が送られる
//   AC-N2: メール本文に、応募者名・日付・時間・店舗名が含まれる
//   AC-N3: メール送信が失敗しても、応募の確定は成功として扱われる（★特に重要）
//   AC-N4: メール送信の失敗がconsole.errorに記録される
//   AC-N5: メール送信は応答を返した後に行われ、応答時間に影響しない（★特に重要）
//   AC-N6: stores.emailがnullの場合、送信をスキップしエラーにならない
//   AC-N7: 既に埋まっている募集への応募（先着で負けた場合）では、通知が送られない（★特に重要）
//   AC-N8: 既存テスト・既存フローが壊れていないことは `npm test` 全体で検証する
//
// 通報通知（test/reportNotification.test.js）・管理者キー復旧（test/keyRecovery.test.js）と
// 同じ方針で、server.jsが実際に構築するExpressアプリ（buildApp()）をそのまま使い、
// supabaseとメール送信関数（sendShiftFilledNotificationEmail）だけをoverridesで差し替える。
// ハンドラ本体・判定順序はすべてserver.js本体のものを検証する。
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

// server.jsは、requireするより前にRESEND_API_KEYが無いと店舗登録関連の一部処理が
// 500になる設計（本番での設定漏れの早期検知のための意図的な仕様）のため、
// 他のテストファイルと同じくダミー値を設定しておく。実際にResend APIへ発信することはない。
if (!process.env.RESEND_API_KEY) {
  process.env.RESEND_API_KEY = 'test-dummy-resend-api-key';
}
const { buildApp } = require('../server');

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// 【AC-N5に伴う対応】通知メール送信は応答後の非同期処理(setImmediate)になったため、
// respondへのPOSTがresolveした時点では、まだテスト側のsendShiftFilledNotificationEmailの
// フェイクが呼ばれていない可能性がある（応答の送信とメール送信はもう同期していない）。
// このヘルパーは、conditionFnがtrueになるまで短い間隔でポーリングする
// （test/keyRecovery.test.jsのwaitForと同じ手法）。
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

// ============================================================
// フェイクSupabase：shifts・subscriptions・storesを模す。
// server.js本体が使う正確なメソッドチェーン（.select().eq().maybeSingle()、
// .update().eq().eq().select().maybeSingle() など）だけをサポートする最小実装。
// ============================================================

// select系チェーン：任意個の.eq()を連鎖でき、最後に.maybeSingle()か、そのままawait
// （supabase-jsのthenable挙動と同じ）のどちらでも結果を取り出せる。
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

function createFakeSupabase({ shifts = [], subscriptions = [], stores = [] } = {}) {
  const shiftsArr = shifts.map((s) => ({ ...s }));
  const subscriptionsArr = subscriptions.map((s) => ({ ...s }));
  const storesArr = stores.map((s) => ({ ...s }));
  const storeQueries = [];

  const supabase = {
    shiftsArr,
    subscriptionsArr,
    storesArr,
    storeQueries,
    from(table) {
      if (table === 'shifts') {
        return {
          select() {
            return filterChain(shiftsArr);
          },
          update(payload) {
            // matchedはshiftsArr内の「生きた」行オブジェクトへの参照を保持したまま絞り込む。
            // UPDATE ... WHERE id=? AND status='open' と同じ意味で、絞り込み後に
            // ちょうど1件残っていた場合だけ実際にmutateする（先着順の再現）。
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
      if (table === 'subscriptions') {
        return {
          select() {
            return filterChain(subscriptionsArr);
          },
        };
      }
      if (table === 'stores') {
        return {
          select() {
            storeQueries.push(true);
            return filterChain(storesArr);
          },
        };
      }
      throw new Error(`想定外のテーブルアクセス: ${table}`);
    },
  };
  return supabase;
}

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

const BASE_STORE = { id: 'store-1', email: 'owner@example.com' };
const BASE_SUBSCRIPTION = { store_id: 'store-1', staff_name: '山田太郎' };

// ============================================================
// AC-N1: 応募が確定すると、店舗のメールアドレス宛に通知が送られる
// ============================================================

test('正常系(AC-N1): 応募が確定すると、店舗のメールアドレス(stores.email)宛に通知メール送信関数が1回呼ばれる', async () => {
  const notifyCalls = [];
  const supabase = createFakeSupabase({ shifts: [BASE_SHIFT], stores: [BASE_STORE], subscriptions: [BASE_SUBSCRIPTION] });
  const app = buildApp({
    supabase,
    sendShiftFilledNotificationEmail: async (args) => {
      notifyCalls.push(args);
    },
  });
  const server = app.listen(0);
  try {
    const res = await postJson(server, `/api/shift/${BASE_SHIFT.id}/respond`, { name: '山田太郎' });
    assert.strictEqual(res.status, 200);
    await waitFor(() => notifyCalls.length === 1);
    assert.strictEqual(notifyCalls[0].storeEmail, BASE_STORE.email);
  } finally {
    server.close();
  }
});

test('異常系(AC-N1): 応募の確定処理自体(UPDATE)が失敗した場合、従来どおり500が返り、通知メールは送られない', async () => {
  const notifyCalls = [];
  const supabase = createFakeSupabase({ shifts: [BASE_SHIFT], stores: [BASE_STORE], subscriptions: [BASE_SUBSCRIPTION] });
  // shifts.updateをDBエラーで失敗させる（server.js側は throw error でcatchに落ちる想定）。
  const originalFrom = supabase.from.bind(supabase);
  supabase.from = (table) => {
    if (table === 'shifts') {
      const real = originalFrom(table);
      return {
        select: real.select,
        update() {
          return {
            eq() {
              return this;
            },
            select() {
              return { maybeSingle: async () => ({ data: null, error: { message: 'update failed (simulated)' } }) };
            },
          };
        },
      };
    }
    return originalFrom(table);
  };
  const app = buildApp({
    supabase,
    sendShiftFilledNotificationEmail: async (args) => {
      notifyCalls.push(args);
    },
  });
  const server = app.listen(0);
  try {
    const res = await postJson(server, `/api/shift/${BASE_SHIFT.id}/respond`, { name: '山田太郎' });
    assert.strictEqual(res.status, 500);
    // 応答が返った後も、通知メールが遅れて送られていないことを確認するため少し待つ。
    await delay(50);
    assert.strictEqual(notifyCalls.length, 0, '確定処理自体が失敗した場合は通知が送られないはず');
  } finally {
    server.close();
  }
});

// ============================================================
// AC-N2: メール本文に、応募者名・日付・時間・店舗名が含まれる
// ============================================================

test('正常系(AC-N2・実装本体): 本物のsendShiftFilledNotificationEmailが、応募者名・日付・時間・店舗名を含む件名/本文を、店舗のメールアドレス宛に送る', async () => {
  const supabase = createFakeSupabase({ shifts: [BASE_SHIFT], stores: [BASE_STORE], subscriptions: [BASE_SUBSCRIPTION] });
  const originalFetch = global.fetch;
  const fetchCalls = [];
  global.fetch = async (url, options) => {
    fetchCalls.push({ url, options });
    return { ok: true, json: async () => ({}) };
  };
  // overrides.sendShiftFilledNotificationEmailを渡さない＝server.js本体の本物の実装を使う。
  const app = buildApp({ supabase });
  const server = app.listen(0);
  try {
    const res = await postJson(server, `/api/shift/${BASE_SHIFT.id}/respond`, { name: '山田太郎' });
    assert.strictEqual(res.status, 200);
    await waitFor(() => fetchCalls.length === 1);
    assert.strictEqual(fetchCalls[0].url, 'https://api.resend.com/emails');
    const requestBody = JSON.parse(fetchCalls[0].options.body);
    // 【AC-N1の核心】宛先が店舗のメールアドレスであること。
    assert.strictEqual(requestBody.to, BASE_STORE.email);
    // 件名だけでも要点（決まったこと・いつのシフトか）が分かること。
    assert.match(requestBody.subject, /代打が決まりました/);
    assert.match(requestBody.subject, /2026-08-20/);
    assert.match(requestBody.subject, /18:00〜22:00/);
    // 【AC-N2の核心】本文に応募者名・日付・時間・店舗名が含まれていること。
    assert.match(requestBody.html, /山田太郎/); // 応募者名(filled_by)
    assert.match(requestBody.html, /2026-08-20/); // 日付(date)
    assert.match(requestBody.html, /18:00〜22:00/); // 時間(time)
    assert.match(requestBody.html, /渋谷店/); // 店舗名
  } finally {
    server.close();
    global.fetch = originalFetch;
  }
});

test('異常系(回帰防止・AC-N2): 店舗名・補足にHTMLタグが含まれていても、メール本文中ではエスケープされてタグとして解釈されない', async () => {
  const maliciousShift = { ...BASE_SHIFT, store_name: '<img src=x onerror=alert(1)>', note: '<script>alert("xss")</script>直前欠勤のため' };
  const maliciousSub = { store_id: 'store-1', staff_name: '<b>なりすまし太郎</b>' };
  const supabase = createFakeSupabase({ shifts: [maliciousShift], stores: [BASE_STORE], subscriptions: [maliciousSub] });
  const originalFetch = global.fetch;
  const fetchCalls = [];
  global.fetch = async (url, options) => {
    fetchCalls.push({ url, options });
    return { ok: true, json: async () => ({}) };
  };
  const app = buildApp({ supabase }); // 本物のsendShiftFilledNotificationEmailを使う
  const server = app.listen(0);
  try {
    const res = await postJson(server, `/api/shift/${maliciousShift.id}/respond`, { name: '<b>なりすまし太郎</b>' });
    assert.strictEqual(res.status, 200);
    await waitFor(() => fetchCalls.length === 1);
    const requestBody = JSON.parse(fetchCalls[0].options.body);
    assert.doesNotMatch(requestBody.html, /<script>/);
    assert.doesNotMatch(requestBody.html, /<img src=x onerror=/);
    assert.doesNotMatch(requestBody.html, /<b>なりすまし太郎<\/b>/);
    // エスケープ後の文字列としては情報が残っているはず。
    assert.match(requestBody.html, /&lt;script&gt;/);
  } finally {
    server.close();
    global.fetch = originalFetch;
  }
});

// ============================================================
// AC-N3（最重要）: メール送信が失敗しても、応募の確定は成功として扱われる
// ============================================================

test('正常系(AC-N3・核心): 通知メール送信関数が例外を投げても、応募の応答は200・成功メッセージのまま変わらない', async () => {
  const supabase = createFakeSupabase({ shifts: [BASE_SHIFT], stores: [BASE_STORE], subscriptions: [BASE_SUBSCRIPTION] });
  const app = buildApp({
    supabase,
    sendShiftFilledNotificationEmail: async () => {
      throw new Error('Resend API error: 500 down');
    },
  });
  const server = app.listen(0);
  try {
    const res = await postJson(server, `/api/shift/${BASE_SHIFT.id}/respond`, { name: '山田太郎' });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.message, '応募が完了しました！ありがとうございます！');
    // DB側も確定済みのまま（食い違いが起きない）。
    assert.strictEqual(supabase.shiftsArr[0].status, 'filled');
    assert.strictEqual(supabase.shiftsArr[0].filled_by, '山田太郎');
  } finally {
    server.close();
  }
});

test('異常系(AC-N3・実装本体): Resend APIがエラー応答(ok:false)を返しても、本物のsendShiftFilledNotificationEmailの例外はcatchされ応答は200のまま', async () => {
  const supabase = createFakeSupabase({ shifts: [BASE_SHIFT], stores: [BASE_STORE], subscriptions: [BASE_SUBSCRIPTION] });
  const originalFetch = global.fetch;
  global.fetch = async () => ({ ok: false, status: 500, text: async () => 'resend api down' });
  const app = buildApp({ supabase }); // 本物のsendShiftFilledNotificationEmailを使う
  const server = app.listen(0);
  try {
    const res = await postJson(server, `/api/shift/${BASE_SHIFT.id}/respond`, { name: '山田太郎' });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.message, '応募が完了しました！ありがとうございます！');
  } finally {
    server.close();
    global.fetch = originalFetch;
  }
});

// ============================================================
// AC-N4: メール送信の失敗がconsole.errorに記録される
// ============================================================

test('正常系(AC-N4): メール送信の失敗がconsole.errorに記録される', async () => {
  const supabase = createFakeSupabase({ shifts: [BASE_SHIFT], stores: [BASE_STORE], subscriptions: [BASE_SUBSCRIPTION] });
  const originalConsoleError = console.error;
  const errorCalls = [];
  console.error = (...args) => {
    errorCalls.push(args);
  };
  const app = buildApp({
    supabase,
    sendShiftFilledNotificationEmail: async () => {
      throw new Error('boom');
    },
  });
  const server = app.listen(0);
  try {
    const res = await postJson(server, `/api/shift/${BASE_SHIFT.id}/respond`, { name: '山田太郎' });
    assert.strictEqual(res.status, 200);
    await waitFor(() =>
      errorCalls.some((args) => String(args[0]).includes('shift filled notification email failed'))
    );
    assert.ok(
      errorCalls.some((args) => String(args[0]).includes('shift filled notification email failed')),
      'console.errorに"shift filled notification email failed"を含む記録が残っているはず'
    );
  } finally {
    server.close();
    console.error = originalConsoleError;
  }
});

test('異常系(回帰防止・AC-N4): メール送信が成功した場合はconsole.errorに記録されない（過剰ログの防止）', async () => {
  const supabase = createFakeSupabase({ shifts: [BASE_SHIFT], stores: [BASE_STORE], subscriptions: [BASE_SUBSCRIPTION] });
  const originalConsoleError = console.error;
  const errorCalls = [];
  console.error = (...args) => {
    errorCalls.push(args);
  };
  const notifyCalls = [];
  const app = buildApp({
    supabase,
    sendShiftFilledNotificationEmail: async (args) => {
      notifyCalls.push(args);
    },
  });
  const server = app.listen(0);
  try {
    const res = await postJson(server, `/api/shift/${BASE_SHIFT.id}/respond`, { name: '山田太郎' });
    assert.strictEqual(res.status, 200);
    await waitFor(() => notifyCalls.length === 1);
    assert.strictEqual(
      errorCalls.some((args) => String(args[0]).includes('shift filled notification email failed')),
      false
    );
  } finally {
    server.close();
    console.error = originalConsoleError;
  }
});

// ============================================================
// AC-N5（最重要）: メール送信は応答を返した後に行われ、応答時間に影響しない
// ============================================================

test('正常系(AC-N5・核心): メール送信に時間がかかっても、応募の応答はそれを待たずに返る（応答後に非同期送信する）', async () => {
  const shift = { ...BASE_SHIFT, id: 'shift-timing' };
  const supabase = createFakeSupabase({ shifts: [shift], stores: [BASE_STORE], subscriptions: [BASE_SUBSCRIPTION] });
  const SIMULATED_MAIL_LATENCY_MS = 300;
  let emailSent = false;
  const app = buildApp({
    supabase,
    sendShiftFilledNotificationEmail: async () => {
      await delay(SIMULATED_MAIL_LATENCY_MS);
      emailSent = true;
    },
  });
  const server = app.listen(0);
  try {
    const t0 = Date.now();
    const res = await postJson(server, `/api/shift/${shift.id}/respond`, { name: '山田太郎' });
    const elapsed = Date.now() - t0;

    assert.strictEqual(res.status, 200);
    // 【核心1】応答はメール送信の遅延(300ms)を待たずに返る。応答が送信をawaitしていれば
    // elapsedは300ms以上になるはずだが、ここではごく短時間で返るはず。
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

test('異常系(AC-N5・回帰防止): メール送信の失敗が、プロセスのunhandledRejectionとして漏れない（try/catchが応答後の非同期処理内にも付いていることの確認）', async () => {
  const shift = { ...BASE_SHIFT, id: 'shift-unhandled' };
  const supabase = createFakeSupabase({ shifts: [shift], stores: [BASE_STORE], subscriptions: [BASE_SUBSCRIPTION] });
  const app = buildApp({
    supabase,
    sendShiftFilledNotificationEmail: async () => {
      throw new Error('Resend API error: 500 simulated failure');
    },
  });
  const server = app.listen(0);

  let unhandled = null;
  const onUnhandledRejection = (err) => {
    unhandled = err;
  };
  process.on('unhandledRejection', onUnhandledRejection);
  try {
    const res = await postJson(server, `/api/shift/${shift.id}/respond`, { name: '山田太郎' });
    assert.strictEqual(res.status, 200);
    // 応答後の非同期処理（setImmediate）が実際に走ってrejectするまで少し待つ。
    await delay(100);
    assert.strictEqual(unhandled, null, 'メール送信の失敗がunhandledRejectionとして漏れてはいけない');
  } finally {
    process.off('unhandledRejection', onUnhandledRejection);
    server.close();
  }
});

// ============================================================
// AC-N6: stores.emailがnullの場合、送信をスキップしエラーにならない
// ============================================================

test('正常系(AC-N6): stores.emailがnullの店舗への応募でも、応募は成功し、通知メール送信は試みられない', async () => {
  const nullEmailStore = { id: 'store-null-email', email: null };
  const shift = { ...BASE_SHIFT, id: 'shift-null-email', store_id: 'store-null-email' };
  const sub = { store_id: 'store-null-email', staff_name: '山田太郎' };
  const notifyCalls = [];
  const supabase = createFakeSupabase({ shifts: [shift], stores: [nullEmailStore], subscriptions: [sub] });
  const originalConsoleError = console.error;
  const errorCalls = [];
  console.error = (...args) => {
    errorCalls.push(args);
  };
  const app = buildApp({
    supabase,
    sendShiftFilledNotificationEmail: async (args) => {
      notifyCalls.push(args);
    },
  });
  const server = app.listen(0);
  try {
    const res = await postJson(server, `/api/shift/${shift.id}/respond`, { name: '山田太郎' });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.message, '応募が完了しました！ありがとうございます！');
    // stores.emailがnullなので送信スキップ。少し待っても呼ばれないことを確認する。
    await delay(50);
    assert.strictEqual(notifyCalls.length, 0, 'stores.emailがnullの場合は送信を試みないはず');
    // エラー扱いにもしない（console.errorにも記録しない）。
    assert.strictEqual(
      errorCalls.some((args) => String(args[0]).includes('shift filled notification email failed')),
      false,
      'stores.emailがnullなのはエラーではないため、失敗ログを残さないはず'
    );
  } finally {
    server.close();
    console.error = originalConsoleError;
  }
});

test('異常系(AC-N6): 店舗が見つからない(storesに該当行が無い)場合でも、応募は成功しエラーにならない', async () => {
  // shift.store_idに対応するstores行を意図的に用意しない（例えば店舗が削除された後の残存データを想定）。
  const shift = { ...BASE_SHIFT, id: 'shift-orphan', store_id: 'store-does-not-exist' };
  const sub = { store_id: 'store-does-not-exist', staff_name: '山田太郎' };
  const notifyCalls = [];
  const supabase = createFakeSupabase({ shifts: [shift], stores: [], subscriptions: [sub] });
  const app = buildApp({
    supabase,
    sendShiftFilledNotificationEmail: async (args) => {
      notifyCalls.push(args);
    },
  });
  const server = app.listen(0);
  try {
    const res = await postJson(server, `/api/shift/${shift.id}/respond`, { name: '山田太郎' });
    assert.strictEqual(res.status, 200);
    await delay(50);
    assert.strictEqual(notifyCalls.length, 0);
  } finally {
    server.close();
  }
});

// ============================================================
// AC-N7（最重要）: 既に埋まっている募集への応募（先着で負けた場合）では、通知が送られない
// ============================================================

test('正常系(AC-N7・核心): 既に他のスタッフが確定させた募集に応募すると409が返り、通知メールは送られない', async () => {
  const alreadyFilledShift = {
    ...BASE_SHIFT,
    id: 'shift-already-filled',
    status: 'filled',
    filled_by: '先に応募した人',
    filled_at: new Date().toISOString(),
  };
  const sub = { store_id: 'store-1', staff_name: '後から来た人' };
  const notifyCalls = [];
  const supabase = createFakeSupabase({
    shifts: [alreadyFilledShift],
    stores: [BASE_STORE],
    subscriptions: [sub],
  });
  const app = buildApp({
    supabase,
    sendShiftFilledNotificationEmail: async (args) => {
      notifyCalls.push(args);
    },
  });
  const server = app.listen(0);
  try {
    const res = await postJson(server, `/api/shift/${alreadyFilledShift.id}/respond`, { name: '後から来た人' });
    assert.strictEqual(res.status, 409);
    assert.strictEqual(res.body.error, '残念、すでに他のスタッフが対応済みです');
    await delay(50);
    assert.strictEqual(notifyCalls.length, 0, '先着で負けた場合は通知が送られないはず');
  } finally {
    server.close();
  }
});

test('異常系(AC-N7): 2人がほぼ同時に同じ募集へ応募した場合でも、通知メールは先着で確定した1件分だけ送られる', async () => {
  const shift = { ...BASE_SHIFT, id: 'shift-race' };
  const subA = { store_id: 'store-1', staff_name: '早いAさん' };
  const subB = { store_id: 'store-1', staff_name: '遅いBさん' };
  const notifyCalls = [];
  const supabase = createFakeSupabase({ shifts: [shift], stores: [BASE_STORE], subscriptions: [subA, subB] });
  const app = buildApp({
    supabase,
    sendShiftFilledNotificationEmail: async (args) => {
      notifyCalls.push(args);
    },
  });
  const server = app.listen(0);
  try {
    const [resA, resB] = await Promise.all([
      postJson(server, `/api/shift/${shift.id}/respond`, { name: '早いAさん' }),
      postJson(server, `/api/shift/${shift.id}/respond`, { name: '遅いBさん' }),
    ]);
    const statuses = [resA.status, resB.status].sort();
    assert.deepStrictEqual(statuses, [200, 409], '一方だけが確定(200)し、もう一方は409になるはず');

    await waitFor(() => notifyCalls.length >= 1, { timeoutMs: 500 }).catch(() => {});
    // 少し待っても2件目が来ないことを確認する（合計で必ず1回だけ）。
    await delay(50);
    assert.strictEqual(notifyCalls.length, 1, '通知は先着で確定した1件分だけ送られるはず');
    const winner = statuses[0] === 200 ? (resA.status === 200 ? '早いAさん' : '遅いBさん') : null;
    assert.strictEqual(notifyCalls[0].filledBy, winner);
  } finally {
    server.close();
  }
});
