'use strict';

// AC-R1〜AC-R6: 通報（/api/report）がreportsテーブルに保存できたら、運営（support@daida-store.jp）
// 宛にメールで通知することの検証。
//
// 【背景】通報は以前、reportsテーブルに保存されるだけで、運営がそれに気づく手段が無かった。
// 本番でテスト通報を送ったところ、DBには正しく保存されていたが誰も気づけなかった実例がある。
// 利用規約第13条2項「合理的な調査」を行うには、まず通報の発生に運営が気づける必要がある。
//
// 【最重要（AC-R3/AC-R4）】メール送信が失敗しても、通報の受付（DB保存）は既に完了しているため、
// 201（受付完了）を返し続けなければならない。ここで500を返すと、利用者には「通報できなかった」
// と見えるのにDBには保存済みという食い違いが生まれ、利用者が通報をやり直せば重複してしまう。
// 一方、通報の保存（INSERT）自体が失敗した場合は、従来どおり500を返す（AC-R5）。
//
// server.js自体はrequireした瞬間にSupabase/Stripe等へ接続する作りのため、
// 既存テスト（test/signupBruteForce.test.js等）と同じ方針で、server.jsが実際に構築した
// Expressアプリ（buildApp()の戻り値）をそのまま使い、supabaseとメール送信関数
// （sendReportNotificationEmail）だけをoverridesで差し替える。ハンドラ本体・判定順序は
// すべてserver.js本体のものを検証する。
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

// server.jsは、requireするより前にRESEND_API_KEYが無いと店舗登録関連の一部処理が
// 500になる設計（本番での設定漏れの早期検知のための意図的な仕様）のため、
// 他のテストファイル（test/signupBruteForce.test.js）と同じくダミー値を設定しておく。
// 実際にResend APIへ発信することはない（fetchをこのファイル内で差し替えるか、
// overrides.sendReportNotificationEmailで差し替えるため）。
if (!process.env.RESEND_API_KEY) {
  process.env.RESEND_API_KEY = 'test-dummy-resend-api-key';
}
const { buildApp } = require('../server');

// server.js内のSUPPORT_EMAIL / REPORT_NOTIFICATION_EMAILと同じ値。
// ユーザー承認済みの通知先で、AC-R1の核心（この宛先に届くこと）を検証するために使う。
const EXPECTED_REPORT_NOTIFICATION_EMAIL = 'support@daida-store.jp';

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
        res.on('data', (chunk) => {
          responseBody += chunk;
        });
        res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(responseBody || '{}') }));
      }
    );
    req.on('error', reject);
    req.end(payload);
  });
}

// reports/storesテーブルへのアクセスだけを模した最小のフェイクSupabase。
// insertErrorを指定すると、通報の保存（INSERT）自体を失敗させられる（AC-R5用）。
function createFakeReportSupabase({ insertError = null, stores = [] } = {}) {
  const insertedRows = [];
  const supabase = {
    insertedRows,
    from(table) {
      if (table === 'stores') {
        return {
          select() {
            return {
              eq(col, val) {
                return {
                  maybeSingle: async () => ({ data: stores.find((s) => s.id === val) || null, error: null }),
                };
              },
            };
          },
        };
      }
      if (table === 'reports') {
        return {
          insert(payload) {
            if (insertError) return Promise.resolve({ error: insertError });
            insertedRows.push(payload);
            return Promise.resolve({ error: null });
          },
        };
      }
      throw new Error(`想定外のテーブルアクセス: ${table}`);
    },
  };
  return supabase;
}

const VALID_REPORT_BODY = {
  target: '迷惑な店長',
  content: 'シフトの給料が支払われません。至急確認してください。',
  reporter: '元スタッフ',
  store_id: 'store-1',
};

// server.jsのREPORT_RATE_LIMIT_MAX_REQUESTS(10分5件)に、同一ファイル内の複数テストが
// 同じキー（IP）で引っかからないよう、テストごとに別のIPを名乗る
// （test/reportGlobalRateLimit.test.jsと同じ手法。trust proxy=1なのでXFFの右端が使われる）。
let nextTestIp = 1;
function uniqueIpHeader() {
  return { 'x-forwarded-for': `203.0.113.${nextTestIp++}` };
}

// ============================================================
// AC-R1・AC-R2: 通報が保存されたら運営宛にメールが送られ、本文に必要な情報が含まれる
// ============================================================

test('正常系(AC-R1・AC-R2): 通報が保存されると、通報内容一式(受信日時・対象・内容・通報者・店舗ID・送信元IP)を渡してメール送信関数が1回呼ばれる', async () => {
  const sentEmails = [];
  const supabase = createFakeReportSupabase({ stores: [{ id: 'store-1' }] });
  const app = buildApp({
    supabase,
    sendReportNotificationEmail: async (report) => {
      sentEmails.push(report);
    },
  });
  const server = app.listen(0);
  try {
    const res = await postJson(server, '/api/report', VALID_REPORT_BODY, uniqueIpHeader());
    assert.strictEqual(res.status, 201);
    assert.strictEqual(sentEmails.length, 1);
    const mail = sentEmails[0];
    assert.strictEqual(mail.target, VALID_REPORT_BODY.target);
    assert.strictEqual(mail.content, VALID_REPORT_BODY.content);
    assert.strictEqual(mail.reporter, VALID_REPORT_BODY.reporter);
    assert.strictEqual(mail.storeId, 'store-1');
    assert.ok(mail.sourceIp, '送信元IPが含まれているはず');
    assert.match(mail.receivedAt, /^\d{4}-\d{2}-\d{2}T/, '受信日時がISO形式で含まれているはず');
    // 保存(INSERT)も正しく行われている（メール通知の実装が保存処理自体を壊していないことの確認）。
    assert.strictEqual(supabase.insertedRows.length, 1);
  } finally {
    server.close();
  }
});

test('正常系(AC-R2・任意項目): 通報者(reporter)が未入力でも受け付けられ、メール送信関数にはnullとして渡る', async () => {
  const sentEmails = [];
  const supabase = createFakeReportSupabase({ stores: [] });
  const app = buildApp({
    supabase,
    sendReportNotificationEmail: async (report) => {
      sentEmails.push(report);
    },
  });
  const server = app.listen(0);
  try {
    const body = { target: '対象', content: '内容だけ入力', store_id: null };
    const res = await postJson(server, '/api/report', body, uniqueIpHeader());
    assert.strictEqual(res.status, 201);
    assert.strictEqual(sentEmails.length, 1);
    assert.strictEqual(sentEmails[0].reporter, null);
    assert.strictEqual(sentEmails[0].storeId, null); // store_id未指定・store_idが実在しない場合はnull
  } finally {
    server.close();
  }
});

// ============================================================
// AC-R1・AC-R2（実装本体）: 本物のsendReportNotificationEmailが、
// 正しい宛先・Resend API形式で、必要な情報を含む本文を送ることの検証。
// 上のテストはoverridesでメール送信関数そのものを差し替えているため、
// 「実際にどのアドレス宛に何を送るか」というserver.js本体の実装（宛先定数・本文組み立て）
// までは検証できていない。ここではoverrides.sendReportNotificationEmailを渡さず、
// server.jsが実際に構築する本物の関数を使い、グローバルfetchだけを差し替えて検証する
// （SDKを使わないfetch実装であることを利用し、新規依存を増やさずに検証できる）。
// ============================================================

test('正常系(AC-R1・AC-R2・実装本体): 本物のsendReportNotificationEmailが、正しい宛先(support@daida-store.jp)へ、受信日時・対象・内容・通報者・店舗ID・送信元IPを含む本文を送る', async () => {
  const supabase = createFakeReportSupabase({ stores: [{ id: 'store-1' }] });
  const originalFetch = global.fetch;
  const fetchCalls = [];
  global.fetch = async (url, options) => {
    fetchCalls.push({ url, options });
    return { ok: true, json: async () => ({}) };
  };
  // overrides.sendReportNotificationEmailを渡さない＝server.js本体の本物の実装を使う。
  const app = buildApp({ supabase });
  const server = app.listen(0);
  try {
    const res = await postJson(server, '/api/report', VALID_REPORT_BODY, uniqueIpHeader());
    assert.strictEqual(res.status, 201);
    assert.strictEqual(fetchCalls.length, 1);
    assert.strictEqual(fetchCalls[0].url, 'https://api.resend.com/emails');
    const requestBody = JSON.parse(fetchCalls[0].options.body);
    // 【AC-R1の核心】宛先が運営のアドレスであること。
    assert.strictEqual(requestBody.to, EXPECTED_REPORT_NOTIFICATION_EMAIL);
    // 【AC-R2の核心】本文に必要な情報がすべて含まれていること。
    assert.match(requestBody.html, /迷惑な店長/); // 通報対象(target)
    assert.match(requestBody.html, /シフトの給料が支払われません/); // 通報内容(content)
    assert.match(requestBody.html, /元スタッフ/); // 通報者(reporter)
    assert.match(requestBody.html, /store-1/); // 店舗ID(store_id)
    assert.match(requestBody.html, /203\.0\.113\.\d+/); // 送信元IP(source_ip)
    assert.match(requestBody.html, /\d{4}-\d{2}-\d{2}T/); // 受信日時
  } finally {
    server.close();
    global.fetch = originalFetch;
  }
});

// 開発担当のミューテーションテストで発見：本物のsendReportNotificationEmailから
// escapeHtml呼び出しを外しても（＝通報内容をHTMLエスケープせずそのまま埋め込んでも）、
// 上記の他のテストは1件も落ちなかった（AC-R2の文言一致チェックが素通りしてしまうため）。
// メール本文はHTMLとして解釈されるため、通報内容（利用者の自由入力）に生のHTMLタグを
// 埋め込めてしまうと、運営が受信するメールの表示が崩れたり、意図しないリンク等が
// 埋め込まれるおそれがある。これを塞ぐため、エスケープそのものを狙い撃ちで検証する。
test('異常系(回帰防止): 通報内容にHTMLタグが含まれていても、メール本文中ではエスケープされてタグとして解釈されない', async () => {
  const supabase = createFakeReportSupabase({ stores: [] });
  const originalFetch = global.fetch;
  const fetchCalls = [];
  global.fetch = async (url, options) => {
    fetchCalls.push({ url, options });
    return { ok: true, json: async () => ({}) };
  };
  const app = buildApp({ supabase }); // 本物のsendReportNotificationEmailを使う
  const server = app.listen(0);
  try {
    const maliciousBody = {
      target: '<img src=x onerror=alert(1)>',
      content: '<script>alert("xss")</script>通報内容',
      reporter: '<b>太字になりすまし</b>',
    };
    const res = await postJson(server, '/api/report', maliciousBody, uniqueIpHeader());
    assert.strictEqual(res.status, 201);
    const requestBody = JSON.parse(fetchCalls[0].options.body);
    // 生のタグがそのまま本文に残っていてはならない（＝エスケープされているはず）。
    assert.doesNotMatch(requestBody.html, /<script>/);
    assert.doesNotMatch(requestBody.html, /<img src=x onerror=/);
    assert.doesNotMatch(requestBody.html, /<b>太字になりすまし<\/b>/);
    // エスケープ後の文字列（&lt;等）としては内容が残っているはず（＝情報が失われていない）。
    assert.match(requestBody.html, /&lt;script&gt;/);
  } finally {
    server.close();
    global.fetch = originalFetch;
  }
});

// ============================================================
// AC-R3・AC-R4（最重要）: メール送信が失敗しても201が返り、通報は保存されたままになる。
// 失敗はconsole.errorに記録される。
// ============================================================

test('異常系(AC-R3・核心): メール送信関数が例外を投げても、通報の受付は201のまま成功として扱われる', async () => {
  const supabase = createFakeReportSupabase({ stores: [] });
  const app = buildApp({
    supabase,
    sendReportNotificationEmail: async () => {
      throw new Error('Resend API error: 500 down');
    },
  });
  const server = app.listen(0);
  try {
    const res = await postJson(server, '/api/report', VALID_REPORT_BODY, uniqueIpHeader());
    assert.strictEqual(res.status, 201);
    assert.strictEqual(res.body.message, '通報を受け付けました。内容を確認いたします。');
    // メール送信が失敗しても、通報自体はDBに保存されたまま（食い違いが起きない）。
    assert.strictEqual(supabase.insertedRows.length, 1);
  } finally {
    server.close();
  }
});

test('異常系(AC-R4): メール送信の失敗がconsole.errorに記録される', async () => {
  const supabase = createFakeReportSupabase({ stores: [] });
  const originalConsoleError = console.error;
  const errorCalls = [];
  console.error = (...args) => {
    errorCalls.push(args);
  };
  const app = buildApp({
    supabase,
    sendReportNotificationEmail: async () => {
      throw new Error('boom');
    },
  });
  const server = app.listen(0);
  try {
    const res = await postJson(server, '/api/report', VALID_REPORT_BODY, uniqueIpHeader());
    assert.strictEqual(res.status, 201);
    assert.ok(
      errorCalls.some((args) => String(args[0]).includes('report notification email error')),
      'console.errorに"report notification email error"を含む記録が残っているはず'
    );
  } finally {
    server.close();
    console.error = originalConsoleError;
  }
});

test('異常系(AC-R3・AC-R4・実装本体): Resend APIがエラー応答(ok:false)を返しても、本物のsendReportNotificationEmailの例外はcatchされ201が返り、console.errorに記録される', async () => {
  const supabase = createFakeReportSupabase({ stores: [] });
  const originalFetch = global.fetch;
  global.fetch = async () => ({ ok: false, status: 500, text: async () => 'resend api down' });
  const originalConsoleError = console.error;
  const errorCalls = [];
  console.error = (...args) => {
    errorCalls.push(args);
  };
  const app = buildApp({ supabase }); // 本物のsendReportNotificationEmailを使う
  const server = app.listen(0);
  try {
    const res = await postJson(server, '/api/report', VALID_REPORT_BODY, uniqueIpHeader());
    assert.strictEqual(res.status, 201);
    assert.strictEqual(supabase.insertedRows.length, 1);
    assert.ok(errorCalls.some((args) => String(args[0]).includes('report notification email error')));
  } finally {
    server.close();
    global.fetch = originalFetch;
    console.error = originalConsoleError;
  }
});

// ============================================================
// AC-R5: 通報の保存（INSERT）自体が失敗した場合は、従来どおり500が返る
// （メール送信を理由に受付を失敗扱いにしていないことの対比としても機能する）
// ============================================================

test('異常系(AC-R5・核心): 通報の保存(INSERT)自体が失敗した場合は、メール送信を試みず従来どおり500が返る', async () => {
  const sentEmails = [];
  const supabase = createFakeReportSupabase({ insertError: { message: 'insert failed' } });
  const app = buildApp({
    supabase,
    sendReportNotificationEmail: async (report) => {
      sentEmails.push(report);
    },
  });
  const server = app.listen(0);
  try {
    const res = await postJson(server, '/api/report', VALID_REPORT_BODY, uniqueIpHeader());
    assert.strictEqual(res.status, 500);
    assert.strictEqual(sentEmails.length, 0, '保存が失敗した場合、メール送信は試みられないはず');
  } finally {
    server.close();
  }
});
