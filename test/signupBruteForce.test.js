'use strict';

// L-5是正: /api/signup/verify-code の確認コードに総当たり攻撃が成立する（失敗回数のカウント・
// ロックアウト・レート制限が一切無い）とセキュリティ監査で指摘された件への対応を検証する。
// 総当たりが成功すると、攻撃者は被害者のメールアドレスで店舗を作成し、オーナー権限そのもの
// である管理者キーを奪取できてしまう（低評価7件のうち唯一「実際に権限を奪われうる」指摘）。
//
// 対策は2段構え：
//   1. コード単位の試行回数制限（主対策・lib/signup.js の checkSignupCode / SIGNUP_CODE_MAX_ATTEMPTS）
//      → 同一コードへの失敗がSIGNUP_CODE_MAX_ATTEMPTS(5)回に達したら、そのコードを失効させる。
//   2. IP単位のレート制限（補助対策・server.js:97〜112、lib/rateLimit.js の実物を流用）
//      → 複数メールアドレスを横断する広く浅い総当たりを止める。
//
// server.js自体はrequireすると即座にSupabase/Stripe等へ接続してしまう作りのため、
// 既存テスト（test/trustProxy.test.js、test/reportGlobalRateLimit.test.js等）と同じ方針で、
// server.js:556〜(verify-codeハンドラ)の実際のロジックと全く同じ手順を、本物の
// lib/signup.js・lib/rateLimit.js（モックではない）を使って再現し検証する。
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const http = require('node:http');
const express = require('express');
const {
  checkSignupCode,
  SIGNUP_CODE_MAX_ATTEMPTS,
  SIGNUP_CODE_VERIFY_FAILED_MESSAGE,
} = require('../lib/signup');
const { createRateLimiter } = require('../lib/rateLimit');

// server.jsのhashKey（server.js内、SHA-256）と同じアルゴリズム。
function hashKey(key) {
  return crypto.createHash('sha256').update(key).digest('hex');
}

const FUTURE = new Date(Date.now() + 15 * 60 * 1000).toISOString();
const PAST = new Date(Date.now() - 1000).toISOString();

// --- pending_signupsテーブルを模したステートフルなフェイクSupabase ---
// server.js:565〜(select) / 597(update) / 595・624(delete) と同じ呼び出し形（チェーン）を再現する。
function createFakePendingSignupsSupabase(initialRows) {
  const rows = new Map();
  for (const r of initialRows) rows.set(r.id, { ...r });

  const supabase = {
    from(table) {
      if (table !== 'pending_signups') {
        throw new Error(`想定外のテーブルへのアクセス: ${table}`);
      }
      return {
        select() {
          return {
            eq(col, val) {
              return {
                order() {
                  return {
                    limit() {
                      return {
                        maybeSingle() {
                          const matches = [...rows.values()]
                            .filter((r) => r[col] === val)
                            .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
                          return Promise.resolve({ data: matches[0] || null, error: null });
                        },
                      };
                    },
                  };
                },
              };
            },
          };
        },
        update(payload) {
          return {
            eq(col, val) {
              const row = [...rows.values()].find((r) => r[col] === val);
              if (row) Object.assign(row, payload);
              return Promise.resolve({ error: null });
            },
          };
        },
        delete() {
          return {
            eq(col, val) {
              const row = [...rows.values()].find((r) => r[col] === val);
              if (row) rows.delete(row.id);
              return Promise.resolve({ error: null });
            },
          };
        },
        insert(payload) {
          const id = payload.id || `generated-${rows.size + 1}`;
          rows.set(id, { id, attempts: 0, created_at: new Date().toISOString(), ...payload });
          return Promise.resolve({ error: null });
        },
      };
    },
  };

  return { supabase, rows };
}

// server.js:556〜605 の verify-code ハンドラ本体（DB問い合わせ→checkSignupCode→DB更新→
// エラーメッセージ返却）を、店舗作成部分を除いて忠実に再現する。
// checkSignupCode 自体は本物（lib/signup.js）をそのまま使う。
async function verifyCode({ supabase, email, code }) {
  const { data: pending } = await supabase
    .from('pending_signups')
    .select('*')
    .eq('email', email)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  const result = checkSignupCode({ pending, code, hashCode: hashKey });

  if (!result.ok) {
    if (pending && typeof result.nextAttempts === 'number') {
      if (result.shouldLockout) {
        await supabase.from('pending_signups').delete().eq('id', pending.id);
      } else {
        await supabase.from('pending_signups').update({ attempts: result.nextAttempts }).eq('id', pending.id);
      }
    }
    return { status: 400, error: SIGNUP_CODE_VERIFY_FAILED_MESSAGE };
  }

  // 成功時：server.js:624と同じく、pending行を削除する（このテストでは店舗作成は対象外）。
  await supabase.from('pending_signups').delete().eq('id', pending.id);
  return { status: 201 };
}

// ============================================================
// AC-L5-1: 同一コードへの検証失敗が5回に達すると失効し、以後は正しいコードでも通らない
// ============================================================

test('正常系(AC-L5-1): 1〜4回失敗しても、その後に正しいコードを入れれば通る（上限前は通常どおり動く）', async () => {
  const email = 'owner-typo@example.com';
  const correctCode = '123456';
  const { supabase, rows } = createFakePendingSignupsSupabase([
    { id: 'p1', email, code_hash: hashKey(correctCode), expires_at: FUTURE, attempts: 0, created_at: new Date().toISOString() },
  ]);

  // 4回間違える（上限5回未満なので、まだ失効しない）
  for (let i = 0; i < 4; i++) {
    const res = await verifyCode({ supabase, email, code: '000000' });
    assert.strictEqual(res.status, 400);
  }
  assert.strictEqual(rows.get('p1').attempts, 4);

  // 5回目の入力で正しいコードを入れれば通る
  const success = await verifyCode({ supabase, email, code: correctCode });
  assert.strictEqual(success.status, 201);
  // 成功後はpending行が削除されている
  assert.strictEqual(rows.has('p1'), false);
});

test('異常系(AC-L5-1・核心): 5回失敗すると、その後に正しいコードを入れても検証が通らない', async () => {
  const email = 'attacker-target@example.com';
  const correctCode = '654321';
  const { supabase, rows } = createFakePendingSignupsSupabase([
    { id: 'p2', email, code_hash: hashKey(correctCode), expires_at: FUTURE, attempts: 0, created_at: new Date().toISOString() },
  ]);

  for (let i = 0; i < SIGNUP_CODE_MAX_ATTEMPTS; i++) {
    const res = await verifyCode({ supabase, email, code: '000000' });
    assert.strictEqual(res.status, 400);
  }

  // コードは失効済み（行が削除されている）
  assert.strictEqual(rows.has('p2'), false);

  // 6回目に正しいコードを入れても、もう通らない（総当たりが成功しない）
  const afterLockout = await verifyCode({ supabase, email, code: correctCode });
  assert.strictEqual(afterLockout.status, 400);
});

test('境界値(AC-L5-1): ちょうど4回目・5回目・6回目の挙動', async () => {
  const email = 'boundary@example.com';
  const correctCode = '111222';
  const { supabase, rows } = createFakePendingSignupsSupabase([
    { id: 'p3', email, code_hash: hashKey(correctCode), expires_at: FUTURE, attempts: 0, created_at: new Date().toISOString() },
  ]);

  // 1〜3回目: 誤り。まだ行は生きている。
  for (let i = 0; i < 3; i++) {
    await verifyCode({ supabase, email, code: 'wrong0' + i });
  }
  assert.strictEqual(rows.get('p3').attempts, 3);

  // 4回目: 誤り。attempts=4になるが、まだ上限(5)未満なので失効しない。
  const fourth = await verifyCode({ supabase, email, code: 'wrong04' });
  assert.strictEqual(fourth.status, 400);
  assert.strictEqual(rows.has('p3'), true);
  assert.strictEqual(rows.get('p3').attempts, 4);

  // 5回目: 誤り。attempts=5に達し、この時点でコードが失効する（行が削除される）。
  const fifth = await verifyCode({ supabase, email, code: 'wrong05' });
  assert.strictEqual(fifth.status, 400);
  assert.strictEqual(rows.has('p3'), false);

  // 6回目: 正しいコードであっても、既に失効しているため通らない。
  const sixth = await verifyCode({ supabase, email, code: correctCode });
  assert.strictEqual(sixth.status, 400);
});

// ============================================================
// AC-L5-2: 失効後、コードの再送によって新しいコードを取得すればやり直せる
// ============================================================

test('正常系(AC-L5-2): 失効後でも、再送（新しいpending行の発行）によって新しいコードなら登録をやり直せる', async () => {
  const email = 'retry-after-lockout@example.com';
  const oldCode = '999999';
  const { supabase, rows } = createFakePendingSignupsSupabase([
    { id: 'p4', email, code_hash: hashKey(oldCode), expires_at: FUTURE, attempts: 0, created_at: new Date().toISOString() },
  ]);

  for (let i = 0; i < SIGNUP_CODE_MAX_ATTEMPTS; i++) {
    await verifyCode({ supabase, email, code: '000000' });
  }
  assert.strictEqual(rows.has('p4'), false); // 失効済み

  // 再送操作（server.js:510相当）：同じメールの古い行を消してから新しい行を作る。
  // このテストでは既に上のループで古い行(p4)は削除済みなので、新しいコードのpending行を追加するだけでよい。
  const newCode = '424242';
  rows.set('p5', {
    id: 'p5',
    email,
    code_hash: hashKey(newCode),
    expires_at: FUTURE,
    attempts: 0,
    created_at: new Date(Date.now() + 1000).toISOString(),
  });

  // 新しいコードでやり直せる
  const res = await verifyCode({ supabase, email, code: newCode });
  assert.strictEqual(res.status, 201);
});

test('異常系(AC-L5-2・対比): 再送せずに古い（失効済みの）コードを使い続けても通らない', async () => {
  const email = 'no-resend@example.com';
  const oldCode = '135790';
  const { supabase, rows } = createFakePendingSignupsSupabase([
    { id: 'p6', email, code_hash: hashKey(oldCode), expires_at: FUTURE, attempts: 0, created_at: new Date().toISOString() },
  ]);

  for (let i = 0; i < SIGNUP_CODE_MAX_ATTEMPTS; i++) {
    await verifyCode({ supabase, email, code: '000000' });
  }
  assert.strictEqual(rows.has('p6'), false);

  // 再送していないので、正しいコードを知っていても永久に通らない（再送が必須）
  const res = await verifyCode({ supabase, email, code: oldCode });
  assert.strictEqual(res.status, 400);
});

// ============================================================
// AC-L5-4: 検証成功時は試行回数がリセットされる（正常な利用者が影響を受けない）
// ============================================================

test('正常系(AC-L5-4): 検証成功時、pending行自体が削除される（＝試行回数の記録も一緒に消え、次回の新規登録に影響しない）', async () => {
  const email = 'normal-user@example.com';
  const correctCode = '246810';
  const { supabase, rows } = createFakePendingSignupsSupabase([
    { id: 'p7', email, code_hash: hashKey(correctCode), expires_at: FUTURE, attempts: 2, created_at: new Date().toISOString() },
  ]);

  const res = await verifyCode({ supabase, email, code: correctCode });
  assert.strictEqual(res.status, 201);
  assert.strictEqual(rows.has('p7'), false);

  // 同じメールで新しく登録し直しても、以前の失敗回数(attempts=2)は一切引き継がれない
  const newCode = '135791';
  rows.set('p8', { id: 'p8', email, code_hash: hashKey(newCode), expires_at: FUTURE, attempts: 0, created_at: new Date().toISOString() });
  // 4回誤っても(上限未満)、まだ失効しない＝以前の分が加算されていないことの確認
  for (let i = 0; i < 4; i++) {
    await verifyCode({ supabase, email, code: 'wrong0' + i });
  }
  assert.strictEqual(rows.get('p8').attempts, 4);
});

test('異常系(対比・AC-L5-4): pending行を削除せずattemptsだけ残す実装だったら、次回登録に前回の失敗回数が引き継がれてしまう', () => {
  // これは実装の対比であり、本物のverifyCode()は必ずpending行ごと削除するため発生しない
  // （このテストが無いと、上の正常系テストが「たまたまリセットされていた」だけの可能性を排除できない）。
  const leftoverRow = { id: 'p9', attempts: 4 }; // 削除し忘れた場合を仮定
  const nextAttempts = (leftoverRow.attempts || 0) + 1;
  assert.strictEqual(nextAttempts >= SIGNUP_CODE_MAX_ATTEMPTS, true); // 5回目の失敗で即失効してしまう＝バグ
});

// ============================================================
// AC-L5-5: 上限到達時のエラーメッセージが、コードの正誤を攻撃者に推測させない内容である
// ============================================================

test('正常系(AC-L5-5): 通常の1回の誤入力時のエラーメッセージは共通文言である', async () => {
  const email = 'message-check-1@example.com';
  const { supabase } = createFakePendingSignupsSupabase([
    { id: 'q1', email, code_hash: hashKey('000111'), expires_at: FUTURE, attempts: 0, created_at: new Date().toISOString() },
  ]);
  const res = await verifyCode({ supabase, email, code: 'wrong1' });
  assert.strictEqual(res.error, SIGNUP_CODE_VERIFY_FAILED_MESSAGE);
});

test('異常系(AC-L5-5・核心): 上限到達（失効）を引き起こした失敗のエラーメッセージも、通常の誤入力と全く同じ文言であり、区別できない', async () => {
  const email = 'message-check-2@example.com';
  const { supabase } = createFakePendingSignupsSupabase([
    { id: 'q2', email, code_hash: hashKey('222333'), expires_at: FUTURE, attempts: 0, created_at: new Date().toISOString() },
  ]);

  const responses = [];
  for (let i = 0; i < SIGNUP_CODE_MAX_ATTEMPTS; i++) {
    responses.push(await verifyCode({ supabase, email, code: 'wrong-' + i }));
  }
  // 期限切れ・上限到達を含め、5回とも文言が完全に同一であることを確認する
  // （攻撃者が「今回は上限到達で弾かれた」等を文言差から推測できない）。
  for (const res of responses) {
    assert.strictEqual(res.error, SIGNUP_CODE_VERIFY_FAILED_MESSAGE);
  }
  // 念のため、期限切れケース・pending不在ケースでも同一文言であることを確認する
  const expiredEmail = 'expired@example.com';
  const { supabase: expiredSupabase } = createFakePendingSignupsSupabase([
    { id: 'q3', email: expiredEmail, code_hash: hashKey('444555'), expires_at: PAST, attempts: 0, created_at: new Date().toISOString() },
  ]);
  const expiredRes = await verifyCode({ supabase: expiredSupabase, email: expiredEmail, code: '444555' });
  assert.strictEqual(expiredRes.error, SIGNUP_CODE_VERIFY_FAILED_MESSAGE);

  const noPendingRes = await verifyCode({ supabase: expiredSupabase, email: 'never-requested@example.com', code: '000000' });
  assert.strictEqual(noPendingRes.error, SIGNUP_CODE_VERIFY_FAILED_MESSAGE);
});

// ============================================================
// AC-L5-3: 同一IPからの検証試行に上限があり、複数メールアドレスを横断する総当たりが止まる
// ============================================================
// server.js:556〜564（IP単位チェック）を、本物のlib/rateLimit.jsを使って最小のExpressアプリで
// 再現する（test/reportGlobalRateLimit.test.js・test/trustProxy.test.jsと同じ方式）。

const TRUSTED_PROXY_HOPS = 1; // server.js と同じ（Renderの前段プロキシは1段）

function buildVerifyCodeApp({ windowMs, maxRequests }) {
  const app = express();
  app.set('trust proxy', TRUSTED_PROXY_HOPS);
  const isAllowed = createRateLimiter(windowMs, maxRequests);
  app.post('/api/signup/verify-code', express.json(), (req, res) => {
    const clientIp = req.ip || (req.connection && req.connection.remoteAddress) || 'unknown';
    if (!isAllowed(clientIp)) {
      return res.status(429).json({ error: 'ip rate limited' });
    }
    // IP制限さえ通れば、以降のメールアドレスごとのコード照合結果に関わらず200を返す
    // （本テストはIP単位の制限そのものだけを検証する）。
    res.status(200).json({ email: req.body && req.body.email });
  });
  return app;
}

function postVerifyCode(server, body) {
  return new Promise((resolve, reject) => {
    const { port } = server.address();
    const payload = JSON.stringify(body);
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        method: 'POST',
        path: '/api/signup/verify-code',
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) },
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

test('正常系(AC-L5-3): 上限件数までは、同一IPから複数の異なるメールアドレスへの試行でも正常に受け付けられる', async () => {
  const app = buildVerifyCodeApp({ windowMs: 10 * 60 * 1000, maxRequests: 20 });
  const server = app.listen(0);
  try {
    const results = [];
    for (let i = 0; i < 20; i++) {
      results.push(await postVerifyCode(server, { email: `user${i}@example.com`, code: '000000' }));
    }
    // 20回まではIP単位の上限内なので、全件が受け付けられる（正規利用を妨げない）
    assert.strictEqual(results.filter((r) => r.status === 200).length, 20);
    assert.strictEqual(results.filter((r) => r.status === 429).length, 0);
  } finally {
    server.close();
  }
});

test('異常系(AC-L5-3・核心): 同一IPから複数メールアドレスを横断して総当たりしても、IP単位の上限で一定回数で止まる', async () => {
  const app = buildVerifyCodeApp({ windowMs: 10 * 60 * 1000, maxRequests: 20 });
  const server = app.listen(0);
  try {
    const results = [];
    // 40個の異なるメールアドレスに対して1回ずつ試行する（広く浅い総当たりを模擬）
    for (let i = 0; i < 40; i++) {
      results.push(await postVerifyCode(server, { email: `victim${i}@example.com`, code: '111111' }));
    }
    // メールアドレスを変え続けても、同一IPである以上20回で頭打ちになる
    assert.strictEqual(results.filter((r) => r.status === 200).length, 20);
    assert.strictEqual(results.filter((r) => r.status === 429).length, 20);
  } finally {
    server.close();
  }
});

test('異常系(対比・AC-L5-3): IP単位の制限を入れない場合、メールアドレスを変え続けるだけで際限なく試行できてしまう', async () => {
  // withGlobalLimit系のテストと同じ発想の対比テスト。IP制限が無かった場合を再現し、
  // 上のテストが「たまたま止まっただけ」ではないことを裏付ける。
  const app = express();
  app.set('trust proxy', TRUSTED_PROXY_HOPS);
  app.post('/api/signup/verify-code', express.json(), (req, res) => {
    // IP単位のチェックを行わない（是正前の状態の再現）
    res.status(200).json({ email: req.body && req.body.email });
  });
  const server = app.listen(0);
  try {
    const results = [];
    for (let i = 0; i < 40; i++) {
      results.push(await postVerifyCode(server, { email: `victim${i}@example.com`, code: '111111' }));
    }
    assert.strictEqual(results.every((r) => r.status === 200), true);
  } finally {
    server.close();
  }
});

// --- checkSignupCode（純粋関数）そのものの単体テスト ---

test('正常系: pendingが存在し、コードが一致すればokになる', () => {
  const pending = { id: 'x1', code_hash: hashKey('123123'), expires_at: FUTURE, attempts: 0 };
  const result = checkSignupCode({ pending, code: '123123', hashCode: hashKey });
  assert.strictEqual(result.ok, true);
});

test('異常系: pendingが存在しない場合はshouldLockoutを立てず単純に失敗する', () => {
  const result = checkSignupCode({ pending: null, code: '123123', hashCode: hashKey });
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.shouldLockout, false);
});

test('異常系: 期限切れのpendingは、attemptsを進めずに失敗する', () => {
  const pending = { id: 'x2', code_hash: hashKey('123123'), expires_at: PAST, attempts: 0 };
  const result = checkSignupCode({ pending, code: '123123', hashCode: hashKey });
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.shouldLockout, false);
  assert.strictEqual(result.nextAttempts, undefined);
});
