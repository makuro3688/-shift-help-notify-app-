'use strict';

// L-5是正: /api/signup/verify-code の確認コードに総当たり攻撃が成立する（失敗回数のカウント・
// ロックアウト・レート制限が一切無い）とセキュリティ監査で指摘された件への対応を検証する。
// 総当たりが成功すると、攻撃者は被害者のメールアドレスで店舗を作成し、オーナー権限そのもの
// である管理者キーを奪取できてしまう。
//
// --- 2周目の是正（本ファイル）---
// 1周目の実装は「SELECTで現在値を読む→アプリ内で+1計算→UPDATEで絶対値を書き込む」という
// 非原子的なread-modify-writeで、セキュリティ監査(SECURITY_REVIEW_L5.md 高-1)のPoCにより
// 「同時200リクエストで1コードにつき最大1000回まで推測できる」ことが実測された。
// さらにチェック担当(CHECK_REPORT_L5.md)から、当時のテストが server.js からコピーした
// verifyCode() を検証しており、server.js本体を書き換えてもテストが検出できない点も
// 指摘された。
//
// 本ファイルは、その両方に対応する：
//   1. 検証・原子的な試行枠消費のロジックは lib/signup.js（本物。テスト用コピーは作らない）を
//      直接呼び出して検証する。
//   2. 同時多発リクエストを実際に発生させる並行性テストを追加し、
//      「1コードあたりの試行回数が並行数によらず常に上限（5回）を超えない」ことを検証する
//      （AC-L5-7・AC-L5-8）。
//   3. request-code の再送クールダウンも同じ欠陥（中-1）を持っていたため、
//      同様に並行性テストで検証する（AC-L5-10）。
//
// 対策は3段構え：
//   1. コード単位の試行回数制限（主対策・lib/signup.js の verifySignupCode /
//      SIGNUP_CODE_MAX_ATTEMPTS）→ consume_signup_attempt RPC（supabase/setup.sql）で
//      「照合の前に、原子的に試行枠を1つ消費する」ことにより、並行数に依存せず
//      1コードあたり最大5回に制限する。
//   2. IP単位のレート制限（補助対策・server.js、lib/rateLimit.js の実物を流用）
//      → 複数メールアドレスを横断する広く浅い総当たりを止める（verify-code・request-code共通）。
//   3. request-code のクールダウンも request_signup_code RPC（supabase/setup.sql）で原子化。
//
// server.js自体はrequireすると即座にSupabase/Stripe等へ接続してしまう作りのため、
// 既存テスト（test/trustProxy.test.js、test/reportGlobalRateLimit.test.js等）と同じ方針で、
// server.jsが実際に呼ぶロジックと全く同じ手順を、本物の lib/signup.js・lib/rateLimit.js
// （モックではない）を使って再現し検証する。DBアクセス部分（Supabaseの.rpc()）だけを
// フェイクに差し替える。
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const http = require('node:http');
const express = require('express');
const {
  isSignupCodeMatch,
  verifySignupCode,
  requestSignupCode,
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

// フェイクSupabaseの.rpc()呼び出しが、実際のネットワーク往復（Supabaseへの1リクエスト）を
// 模すために挟む遅延。セキュリティ監査のPoCと同じ8msを採用する
// （このミリ秒自体に意味があるわけではなく、「awaitで一度他の処理に制御が渡る」ことを
// 再現できれば十分だが、監査時の実測値に合わせて再現性を持たせている）。
const NETWORK_ROUND_TRIP_DELAY_MS = 8;

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// pending_signupsテーブルと、consume_signup_attempt / request_signup_code の2つのRPC
// （supabase/setup.sql）を模した、ステートフルなフェイクSupabase。
//
// 【原子性の再現方法（重要）】実際のPostgresでは、これらのRPCはそれぞれ単一のSQL文であり、
// 行ロックによって「複数の同時呼び出しの間で処理が割り込まれない」ことが保証される
// （これが高-1・中-1の是正の核心）。これをJSのフェイクで再現するため、状態の
// 読み取り・判定・書き込みを .rpc() のメソッド本体の中で一切 await を挟まず完全に同期的に
// 行い、ネットワーク往復の遅延は「状態変更が完了した後に返すPromiseの解決タイミング」にのみ
// 加える。Node.jsは単一スレッドで動くため、複数の verifySignupCode() / requestSignupCode()
// 呼び出しを同時に開始しても、各呼び出しの中の「await直前までの同期処理」（＝.rpc()の
// 同期的な本体）が他の呼び出しの同期処理に割り込まれることはない。これは実際のPostgresの
// 行ロックと同じ効果（＝一度に1つの呼び出しだけが状態を確定できる）を生む。
//
// 逆に、もし lib/signup.js 側が「読み取り→JS側で判定→書き込み」のように .rpc() を複数回に
// 分けて呼ぶ実装に戻ってしまったら（＝1周目の脆弱な実装への先祖返り）、awaitで一度制御を
// 手放す回数が増えるため、この遅延がある環境では他の同時呼び出しが割り込む余地が生まれ、
// 下記の並行性テスト（AC-L5-7〜8・AC-L5-10）が失敗するようになる。
function createFakeSignupRpcSupabase(initialRows, { delayMs = NETWORK_ROUND_TRIP_DELAY_MS } = {}) {
  const rows = new Map();
  for (const r of initialRows) rows.set(r.id, { ...r });
  let nextGeneratedId = rows.size + 1;

  const supabase = {
    rpc(fnName, params) {
      if (fnName === 'consume_signup_attempt') {
        // supabase/setup.sql の consume_signup_attempt と同じ判定を、同期的に1回で行う。
        // 「該当メールの最新行を探し、attempts < p_max かつ期限内なら1つ加算して返す」。
        const matches = [...rows.values()]
          .filter((r) => r.email === params.p_email)
          .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
        const target = matches[0];
        let resultRows = [];
        if (target && target.attempts < params.p_max && new Date(target.expires_at) > new Date()) {
          target.attempts += 1;
          resultRows = [{ ...target }];
        }
        return delay(delayMs).then(() => ({ data: resultRows, error: null }));
      }

      if (fnName === 'request_signup_code') {
        // supabase/setup.sql の request_signup_code と同じ判定を、同期的に1回で行う。
        // 「該当メールの既存行が無い、またはクールダウンが経過していれば、
        //   （既存行があれば上書きする形で）attempts=0の新しい行を作る」。
        const now = Date.now();
        const existing = [...rows.values()].find((r) => r.email === params.p_email);
        const cooldownElapsedMs = params.p_cooldown_seconds * 1000;
        let responseRow;
        if (!existing || now - new Date(existing.created_at).getTime() >= cooldownElapsedMs) {
          const id = existing ? existing.id : `generated-${nextGeneratedId++}`;
          rows.set(id, {
            id,
            email: params.p_email,
            name: params.p_name,
            code_hash: params.p_code_hash,
            expires_at: params.p_expires_at,
            attempts: 0,
            created_at: new Date(now).toISOString(),
          });
          responseRow = { accepted: true, retry_after_seconds: 0 };
        } else {
          const remainingMs = cooldownElapsedMs - (now - new Date(existing.created_at).getTime());
          responseRow = { accepted: false, retry_after_seconds: Math.max(0, Math.ceil(remainingMs / 1000)) };
        }
        return delay(delayMs).then(() => ({ data: [responseRow], error: null }));
      }

      throw new Error(`想定外のRPC呼び出し: ${fnName}`);
    },
  };

  return { supabase, rows };
}

// ============================================================
// AC-L5-1: 同一コードへの検証失敗が5回に達すると失効し、以後は正しいコードでも通らない
// （本物の lib/signup.js の verifySignupCode を直接呼び出して検証する）
// ============================================================

test('正常系(AC-L5-1): 1〜4回失敗しても、その後に正しいコードを入れれば通る（上限前は通常どおり動く）', async () => {
  const email = 'owner-typo@example.com';
  const correctCode = '123456';
  const { supabase, rows } = createFakeSignupRpcSupabase([
    { id: 'p1', email, code_hash: hashKey(correctCode), expires_at: FUTURE, attempts: 0, created_at: new Date().toISOString() },
  ]);

  for (let i = 0; i < 4; i++) {
    const result = await verifySignupCode({ supabase, email, code: '000000', hashCode: hashKey, maxAttempts: SIGNUP_CODE_MAX_ATTEMPTS });
    assert.strictEqual(result.ok, false);
  }
  assert.strictEqual(rows.get('p1').attempts, 4);

  // 5回目の入力で正しいコードを入れれば通る
  const success = await verifySignupCode({ supabase, email, code: correctCode, hashCode: hashKey, maxAttempts: SIGNUP_CODE_MAX_ATTEMPTS });
  assert.strictEqual(success.ok, true);
  assert.strictEqual(success.pending.id, 'p1');
});

test('異常系(AC-L5-1・核心): 5回失敗すると、その後に正しいコードを入れても検証が通らない', async () => {
  const email = 'attacker-target@example.com';
  const correctCode = '654321';
  const { supabase, rows } = createFakeSignupRpcSupabase([
    { id: 'p2', email, code_hash: hashKey(correctCode), expires_at: FUTURE, attempts: 0, created_at: new Date().toISOString() },
  ]);

  for (let i = 0; i < SIGNUP_CODE_MAX_ATTEMPTS; i++) {
    const result = await verifySignupCode({ supabase, email, code: '000000', hashCode: hashKey, maxAttempts: SIGNUP_CODE_MAX_ATTEMPTS });
    assert.strictEqual(result.ok, false);
  }
  assert.strictEqual(rows.get('p2').attempts, SIGNUP_CODE_MAX_ATTEMPTS);

  // 6回目に正しいコードを入れても、もう通らない（総当たりが成功しない）。
  // consume_signup_attemptのWHERE句(attempts < p_max)が自然に弾くため、行の削除は不要。
  const afterLockout = await verifySignupCode({ supabase, email, code: correctCode, hashCode: hashKey, maxAttempts: SIGNUP_CODE_MAX_ATTEMPTS });
  assert.strictEqual(afterLockout.ok, false);
  // 上限到達後は、これ以上attemptsが進まないことも確認する（RPCが無条件加算ではない証拠）。
  assert.strictEqual(rows.get('p2').attempts, SIGNUP_CODE_MAX_ATTEMPTS);
});

test('境界値(AC-L5-1): ちょうど4回目・5回目・6回目の挙動', async () => {
  const email = 'boundary@example.com';
  const correctCode = '111222';
  const { supabase, rows } = createFakeSignupRpcSupabase([
    { id: 'p3', email, code_hash: hashKey(correctCode), expires_at: FUTURE, attempts: 0, created_at: new Date().toISOString() },
  ]);

  for (let i = 0; i < 3; i++) {
    await verifySignupCode({ supabase, email, code: 'wrong0' + i, hashCode: hashKey, maxAttempts: SIGNUP_CODE_MAX_ATTEMPTS });
  }
  assert.strictEqual(rows.get('p3').attempts, 3);

  // 4回目: 誤り。attempts=4になるが、まだ上限(5)未満なので失効しない。
  const fourth = await verifySignupCode({ supabase, email, code: 'wrong04', hashCode: hashKey, maxAttempts: SIGNUP_CODE_MAX_ATTEMPTS });
  assert.strictEqual(fourth.ok, false);
  assert.strictEqual(rows.get('p3').attempts, 4);

  // 5回目: 誤り。attempts=5に達し、この時点でコードが事実上失効する（以後は消費できない）。
  const fifth = await verifySignupCode({ supabase, email, code: 'wrong05', hashCode: hashKey, maxAttempts: SIGNUP_CODE_MAX_ATTEMPTS });
  assert.strictEqual(fifth.ok, false);
  assert.strictEqual(rows.get('p3').attempts, 5);

  // 6回目: 正しいコードであっても、既に上限到達しているため通らない。
  const sixth = await verifySignupCode({ supabase, email, code: correctCode, hashCode: hashKey, maxAttempts: SIGNUP_CODE_MAX_ATTEMPTS });
  assert.strictEqual(sixth.ok, false);
  assert.strictEqual(rows.get('p3').attempts, 5); // これ以上は増えない
});

test('異常系: 期限切れのpendingは、attemptsを進めずに失敗する', async () => {
  const email = 'expired-pending@example.com';
  const { supabase, rows } = createFakeSignupRpcSupabase([
    { id: 'p10', email, code_hash: hashKey('123123'), expires_at: PAST, attempts: 0, created_at: new Date().toISOString() },
  ]);
  const result = await verifySignupCode({ supabase, email, code: '123123', hashCode: hashKey, maxAttempts: SIGNUP_CODE_MAX_ATTEMPTS });
  assert.strictEqual(result.ok, false);
  // consume_signup_attemptのWHERE句(expires_at > now())が弾くため、attemptsは変化しない。
  assert.strictEqual(rows.get('p10').attempts, 0);
});

// ============================================================
// AC-L5-2: 失効後、コードの再送によって新しいコードを取得すればやり直せる
// （requestSignupCode / verifySignupCode ともに本物の lib/signup.js を使う）
// ============================================================

// このセクションではattemptsのロジックだけを見たいため、クールダウンは0秒にして
// 「再送すれば即座にやり直せる」状態にする（クールダウン自体の検証はAC-L5-10で行う）。
const NO_COOLDOWN_SECONDS = 0;

test('正常系(AC-L5-2): 失効後でも、再送（requestSignupCodeによる新しいpending行の発行）によって新しいコードなら登録をやり直せる', async () => {
  const email = 'retry-after-lockout@example.com';
  const oldCode = '999999';
  const { supabase, rows } = createFakeSignupRpcSupabase([
    { id: 'p4', email, code_hash: hashKey(oldCode), expires_at: FUTURE, attempts: 0, created_at: new Date().toISOString() },
  ]);

  for (let i = 0; i < SIGNUP_CODE_MAX_ATTEMPTS; i++) {
    await verifySignupCode({ supabase, email, code: '000000', hashCode: hashKey, maxAttempts: SIGNUP_CODE_MAX_ATTEMPTS });
  }
  assert.strictEqual(rows.get('p4').attempts, SIGNUP_CODE_MAX_ATTEMPTS); // 失効済み

  // 再送操作（server.js /api/signup/request-code 相当。本物のrequestSignupCodeを呼ぶ）
  const newCode = '424242';
  const requestResult = await requestSignupCode({
    supabase,
    email,
    name: '牛久店',
    codeHash: hashKey(newCode),
    expiresAt: FUTURE,
    cooldownSeconds: NO_COOLDOWN_SECONDS,
  });
  assert.strictEqual(requestResult.accepted, true);

  // 新しいコードでやり直せる。かつ試行回数は0から再スタートしている。
  const res = await verifySignupCode({ supabase, email, code: newCode, hashCode: hashKey, maxAttempts: SIGNUP_CODE_MAX_ATTEMPTS });
  assert.strictEqual(res.ok, true);
});

test('異常系(AC-L5-2・対比): 再送せずに古い（失効済みの）コードを使い続けても通らない', async () => {
  const email = 'no-resend@example.com';
  const oldCode = '135790';
  const { supabase, rows } = createFakeSignupRpcSupabase([
    { id: 'p6', email, code_hash: hashKey(oldCode), expires_at: FUTURE, attempts: 0, created_at: new Date().toISOString() },
  ]);

  for (let i = 0; i < SIGNUP_CODE_MAX_ATTEMPTS; i++) {
    await verifySignupCode({ supabase, email, code: '000000', hashCode: hashKey, maxAttempts: SIGNUP_CODE_MAX_ATTEMPTS });
  }
  assert.strictEqual(rows.get('p6').attempts, SIGNUP_CODE_MAX_ATTEMPTS);

  // 再送していないので、正しいコードを知っていても永久に通らない（再送が必須）
  const res = await verifySignupCode({ supabase, email, code: oldCode, hashCode: hashKey, maxAttempts: SIGNUP_CODE_MAX_ATTEMPTS });
  assert.strictEqual(res.ok, false);
});

// ============================================================
// AC-L5-4: 検証成功時は試行回数がリセットされる（正常な利用者が影響を受けない）
// ============================================================
// 【設計メモ】request_signup_code RPCは、ON CONFLICT DO UPDATEで常に attempts=0 に
// リセットしてから新しいコードを発行する（クールダウンが経過している前提）。
// そのため「以前の失敗回数が新しい登録に引き継がれない」保証は、
// server.jsが検証成功後にpending行を削除するかどうかに依存せず、requestSignupCode自体が
// 担っている。これを本物のrequestSignupCode・verifySignupCodeの組み合わせで検証する。

test('正常系(AC-L5-4): 検証成功後に再度コードを要求しても、以前の失敗回数(4)は新しい登録に引き継がれない', async () => {
  const email = 'normal-user@example.com';
  const correctCode = '246810';
  const { supabase, rows } = createFakeSignupRpcSupabase([
    { id: 'p7', email, code_hash: hashKey(correctCode), expires_at: FUTURE, attempts: 2, created_at: new Date().toISOString() },
  ]);

  // 前回2回誤っていた状態から、正しいコードで成功する。
  const success = await verifySignupCode({ supabase, email, code: correctCode, hashCode: hashKey, maxAttempts: SIGNUP_CODE_MAX_ATTEMPTS });
  assert.strictEqual(success.ok, true);

  // 同じメールで新しく登録し直す（本物のrequestSignupCode。cooldown=0で即座に発行）。
  const newCode = '135791';
  const requestResult = await requestSignupCode({
    supabase,
    email,
    name: '牛久店',
    codeHash: hashKey(newCode),
    expiresAt: FUTURE,
    cooldownSeconds: NO_COOLDOWN_SECONDS,
  });
  assert.strictEqual(requestResult.accepted, true);
  assert.strictEqual(rows.get('p7').attempts, 0); // 新規発行でattemptsが0にリセットされている

  // 4回誤っても(上限未満)、まだ失効しない＝以前の分(2または5)が加算されていないことの確認。
  // もし以前の失敗回数が引き継がれていたら、ここで5に達し失効してしまうはず。
  for (let i = 0; i < 4; i++) {
    const r = await verifySignupCode({ supabase, email, code: 'wrong0' + i, hashCode: hashKey, maxAttempts: SIGNUP_CODE_MAX_ATTEMPTS });
    assert.strictEqual(r.ok, false);
  }
  assert.strictEqual(rows.get('p7').attempts, 4);
});

// ============================================================
// AC-L5-5: 上限到達時のエラーメッセージが、コードの正誤を攻撃者に推測させない内容である
// ============================================================
// 実際のserver.js（/api/signup/verify-code）は、verifySignupCodeが{ok:false}を返した
// 場合、理由（該当なし／期限切れ／上限到達／コード不一致）を一切区別せず常に
// SIGNUP_CODE_VERIFY_FAILED_MESSAGE を返す。そのため、このメッセージの一貫性を保証すべき
// 主体は「verifySignupCodeがok:falseを返すすべてのケースで、server.js側が同じ定数を返す」
// という設計そのものにある。ここでは、その入力（ok:falseになる各ケース）を
// 本物のverifySignupCodeで再現し、実装を書き換えてもこのテストが機能し続けることを保証する。

test('正常系(AC-L5-5): 通常の1回の誤入力ではok:falseになる（server.js側は常にSIGNUP_CODE_VERIFY_FAILED_MESSAGEを返す設計）', async () => {
  const email = 'message-check-1@example.com';
  const { supabase } = createFakeSignupRpcSupabase([
    { id: 'q1', email, code_hash: hashKey('000111'), expires_at: FUTURE, attempts: 0, created_at: new Date().toISOString() },
  ]);
  const result = await verifySignupCode({ supabase, email, code: 'wrong1', hashCode: hashKey, maxAttempts: SIGNUP_CODE_MAX_ATTEMPTS });
  assert.strictEqual(result.ok, false);
});

test('異常系(AC-L5-5・核心): 通常の誤入力・上限到達・期限切れ・pending不在のいずれも同じ ok:false になり、区別できる情報を一切含まない', async () => {
  const email = 'message-check-2@example.com';
  const { supabase } = createFakeSignupRpcSupabase([
    { id: 'q2', email, code_hash: hashKey('222333'), expires_at: FUTURE, attempts: 0, created_at: new Date().toISOString() },
  ]);

  const results = [];
  for (let i = 0; i < SIGNUP_CODE_MAX_ATTEMPTS; i++) {
    results.push(await verifySignupCode({ supabase, email, code: 'wrong-' + i, hashCode: hashKey, maxAttempts: SIGNUP_CODE_MAX_ATTEMPTS }));
  }
  // 通常の誤入力(1〜4回目)・上限到達を引き起こした失敗(5回目)のいずれも、
  // 返す構造は{ok:false}のみで、shouldLockoutのような「今回で失効した」という
  // 区別可能な追加情報を一切含まない（＝server.js側で文言を出し分けようがない）。
  for (const r of results) {
    assert.deepStrictEqual(r, { ok: false });
  }

  // 期限切れケース
  const expiredEmail = 'expired@example.com';
  const { supabase: expiredSupabase } = createFakeSignupRpcSupabase([
    { id: 'q3', email: expiredEmail, code_hash: hashKey('444555'), expires_at: PAST, attempts: 0, created_at: new Date().toISOString() },
  ]);
  const expiredRes = await verifySignupCode({ supabase: expiredSupabase, email: expiredEmail, code: '444555', hashCode: hashKey, maxAttempts: SIGNUP_CODE_MAX_ATTEMPTS });
  assert.deepStrictEqual(expiredRes, { ok: false });

  // pending不在ケース（誤ったメールアドレス）
  const noPendingRes = await verifySignupCode({ supabase: expiredSupabase, email: 'never-requested@example.com', code: '000000', hashCode: hashKey, maxAttempts: SIGNUP_CODE_MAX_ATTEMPTS });
  assert.deepStrictEqual(noPendingRes, { ok: false });
});

// ============================================================
// AC-L5-3: 同一IPからの検証試行に上限があり、複数メールアドレスを横断する総当たりが止まる
// ============================================================
// server.js:verify-codeハンドラ冒頭のIP単位チェックを、本物のlib/rateLimit.jsを使って
// 最小のExpressアプリで再現する（test/reportGlobalRateLimit.test.js・test/trustProxy.test.js
// と同じ方式）。

const TRUSTED_PROXY_HOPS = 1; // server.js と同じ（Renderの前段プロキシは1段）

// server.jsのVERIFY_CODE_IP_RATE_LIMIT_*と同じ値（10分/20回）。
const VERIFY_CODE_IP_RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000;
const VERIFY_CODE_IP_RATE_LIMIT_MAX_REQUESTS = 20;

function buildVerifyCodeApp({ windowMs, maxRequests }) {
  const app = express();
  app.set('trust proxy', TRUSTED_PROXY_HOPS);
  const isAllowed = createRateLimiter(windowMs, maxRequests);
  app.post('/api/signup/verify-code', express.json(), (req, res) => {
    const clientIp = req.ip || (req.connection && req.connection.remoteAddress) || 'unknown';
    if (!isAllowed(clientIp)) {
      return res.status(429).json({ error: 'ip rate limited' });
    }
    res.status(200).json({ email: req.body && req.body.email });
  });
  return app;
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
  const app = buildVerifyCodeApp({ windowMs: VERIFY_CODE_IP_RATE_LIMIT_WINDOW_MS, maxRequests: VERIFY_CODE_IP_RATE_LIMIT_MAX_REQUESTS });
  const server = app.listen(0);
  try {
    const results = [];
    for (let i = 0; i < VERIFY_CODE_IP_RATE_LIMIT_MAX_REQUESTS; i++) {
      results.push(await postJson(server, '/api/signup/verify-code', { email: `user${i}@example.com`, code: '000000' }));
    }
    assert.strictEqual(results.filter((r) => r.status === 200).length, VERIFY_CODE_IP_RATE_LIMIT_MAX_REQUESTS);
    assert.strictEqual(results.filter((r) => r.status === 429).length, 0);
  } finally {
    server.close();
  }
});

test('異常系(AC-L5-3・核心): 同一IPから複数メールアドレスを横断して総当たりしても、IP単位の上限で一定回数で止まる', async () => {
  const app = buildVerifyCodeApp({ windowMs: VERIFY_CODE_IP_RATE_LIMIT_WINDOW_MS, maxRequests: VERIFY_CODE_IP_RATE_LIMIT_MAX_REQUESTS });
  const server = app.listen(0);
  try {
    const results = [];
    const totalAttempts = VERIFY_CODE_IP_RATE_LIMIT_MAX_REQUESTS * 2;
    for (let i = 0; i < totalAttempts; i++) {
      results.push(await postJson(server, '/api/signup/verify-code', { email: `victim${i}@example.com`, code: '111111' }));
    }
    assert.strictEqual(results.filter((r) => r.status === 200).length, VERIFY_CODE_IP_RATE_LIMIT_MAX_REQUESTS);
    assert.strictEqual(results.filter((r) => r.status === 429).length, VERIFY_CODE_IP_RATE_LIMIT_MAX_REQUESTS);
  } finally {
    server.close();
  }
});

// ============================================================
// 中-1是正: /api/signup/request-code のIP単位・サービス全体レート制限
// ============================================================
// server.jsのREQUEST_CODE_IP_RATE_LIMIT_*・REQUEST_CODE_GLOBAL_RATE_LIMIT_*と同じ値。
const REQUEST_CODE_IP_RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000; // 1時間
const REQUEST_CODE_IP_RATE_LIMIT_MAX_REQUESTS = 10; // 1IPあたり1時間に10通まで
const REQUEST_CODE_GLOBAL_RATE_LIMIT_MAX_REQUESTS = 300; // サービス全体で1時間あたり300通まで

function buildRequestCodeApp({ ipMax, globalMax }) {
  const app = express();
  app.set('trust proxy', TRUSTED_PROXY_HOPS);
  const isAllowedByIp = createRateLimiter(REQUEST_CODE_IP_RATE_LIMIT_WINDOW_MS, ipMax);
  const isAllowedGlobally = createRateLimiter(REQUEST_CODE_IP_RATE_LIMIT_WINDOW_MS, globalMax);
  app.post('/api/signup/request-code', express.json(), (req, res) => {
    const clientIp = req.ip || (req.connection && req.connection.remoteAddress) || 'unknown';
    if (!isAllowedByIp(clientIp) || !isAllowedGlobally('global')) {
      return res.status(429).json({ error: 'rate limited' });
    }
    res.status(200).json({ email: req.body && req.body.email });
  });
  return app;
}

test('正常系(中-1): 同一IPからのrequest-codeは、IP上限(10通/時)までは正常に受け付けられる', async () => {
  const app = buildRequestCodeApp({ ipMax: REQUEST_CODE_IP_RATE_LIMIT_MAX_REQUESTS, globalMax: REQUEST_CODE_GLOBAL_RATE_LIMIT_MAX_REQUESTS });
  const server = app.listen(0);
  try {
    const results = [];
    for (let i = 0; i < REQUEST_CODE_IP_RATE_LIMIT_MAX_REQUESTS; i++) {
      results.push(await postJson(server, '/api/signup/request-code', { name: '店', email: `user${i}@example.com` }));
    }
    assert.strictEqual(results.every((r) => r.status === 200), true);
  } finally {
    server.close();
  }
});

test('異常系(中-1・核心): 同一IPからrequest-codeを上限を超えて送ると、IP単位の制限で止まる（メール爆撃の踏み台化を防ぐ）', async () => {
  const app = buildRequestCodeApp({ ipMax: REQUEST_CODE_IP_RATE_LIMIT_MAX_REQUESTS, globalMax: REQUEST_CODE_GLOBAL_RATE_LIMIT_MAX_REQUESTS });
  const server = app.listen(0);
  try {
    const results = [];
    const totalAttempts = REQUEST_CODE_IP_RATE_LIMIT_MAX_REQUESTS * 2;
    for (let i = 0; i < totalAttempts; i++) {
      // 被害者は同一メールアドレス（メール爆撃を模す）。異なるメールでも同様にIP単位で止まる。
      results.push(await postJson(server, '/api/signup/request-code', { name: '店', email: 'victim@example.com' }));
    }
    assert.strictEqual(results.filter((r) => r.status === 200).length, REQUEST_CODE_IP_RATE_LIMIT_MAX_REQUESTS);
    assert.strictEqual(results.filter((r) => r.status === 429).length, REQUEST_CODE_IP_RATE_LIMIT_MAX_REQUESTS);
  } finally {
    server.close();
  }
});

// ============================================================
// AC-L5-7 / AC-L5-8: 並行性テスト（レース条件の是正そのものを検証する）
// ============================================================
// セキュリティ監査(SECURITY_REVIEW_L5.md 高-1)のPoCでは、1周目の実装（read-modify-write）に
// 対して同時200リクエストを送ると、1コードにつき最大1000回まで推測できてしまうことが
// 実測された。ここでは同じ規模の並行リクエストを、本物のverifySignupCode（RPCベースの
// 是正後の実装）に対して発生させ、上限を超えないことを直接検証する。
const CONCURRENT_WRONG_GUESS_COUNT = 200; // 監査PoCと同じ規模（同時200件）
const CONCURRENT_LOCKOUT_PROBE_COUNT = 50; // 上限到達後、正しいコードで並行アクセスを試みる件数

test('AC-L5-7: 同時200件の誤ったコード検証を投げても、1つの確認コードに対する試行回数は上限(5回)を超えない', async () => {
  const email = 'race-wrong-guess@example.com';
  const correctCode = '777777';
  const { supabase, rows } = createFakeSignupRpcSupabase([
    { id: 'race1', email, code_hash: hashKey(correctCode), expires_at: FUTURE, attempts: 0, created_at: new Date().toISOString() },
  ]);

  // 同時にCONCURRENT_WRONG_GUESS_COUNT件の誤ったコードで検証を試みる（攻撃者の総当たりを模す）。
  const results = await Promise.all(
    Array.from({ length: CONCURRENT_WRONG_GUESS_COUNT }, (_, i) =>
      verifySignupCode({ supabase, email, code: `wrong-${i}`, hashCode: hashKey, maxAttempts: SIGNUP_CODE_MAX_ATTEMPTS })
    )
  );

  // 【AC-L5-7の核心】200件同時に投げても、実際にattemptsとして消費された（＝照合に進めた）
  // 回数は厳密にSIGNUP_CODE_MAX_ATTEMPTS(5)を超えない。1周目の実装ではここが並行数倍
  // （このケースなら最大1000）に水増しされていた。
  assert.strictEqual(rows.get('race1').attempts, SIGNUP_CODE_MAX_ATTEMPTS);
  assert.ok(rows.get('race1').attempts <= SIGNUP_CODE_MAX_ATTEMPTS, '試行回数が上限を超えてはならない');
  // 誤ったコードなので、どの結果も成功しない。
  assert.strictEqual(results.every((r) => r.ok === false), true);
});

test('AC-L5-8: 上限到達後は、正しいコードで並行アクセスしても検証は一切通らない', async () => {
  const email = 'race-lockout-probe@example.com';
  const correctCode = '888888';
  const { supabase, rows } = createFakeSignupRpcSupabase([
    { id: 'race2', email, code_hash: hashKey(correctCode), expires_at: FUTURE, attempts: 0, created_at: new Date().toISOString() },
  ]);

  // まず5回誤って上限に到達させる（逐次実行で確実に上限へ）。
  for (let i = 0; i < SIGNUP_CODE_MAX_ATTEMPTS; i++) {
    await verifySignupCode({ supabase, email, code: '000000', hashCode: hashKey, maxAttempts: SIGNUP_CODE_MAX_ATTEMPTS });
  }
  assert.strictEqual(rows.get('race2').attempts, SIGNUP_CODE_MAX_ATTEMPTS);

  // 上限到達後、正しいコードでCONCURRENT_LOCKOUT_PROBE_COUNT件を同時に試みる。
  const results = await Promise.all(
    Array.from({ length: CONCURRENT_LOCKOUT_PROBE_COUNT }, () =>
      verifySignupCode({ supabase, email, code: correctCode, hashCode: hashKey, maxAttempts: SIGNUP_CODE_MAX_ATTEMPTS })
    )
  );

  // 【AC-L5-8の核心】並行アクセス下でも、1件たりとも成功しない。
  assert.strictEqual(results.every((r) => r.ok === false), true);
  // 上限到達後はRPCのWHERE句(attempts < p_max)が弾くため、attemptsもこれ以上増えない。
  assert.strictEqual(rows.get('race2').attempts, SIGNUP_CODE_MAX_ATTEMPTS);
});

test('AC-L5-7・応用: 5回の枠のうち1回が正解でも、合計消費回数は上限を超えず、成功は高々1件だけになる', async () => {
  // 攻撃者が最後の1枠に正解を紛れ込ませて並行送信するケースを模す。
  // 正解が5枠のうちどれか1つを取れれば、その回だけok:trueになってよい（設計どおり）。
  // ただし、それでも合計の消費回数が上限を超えてはならない。
  const email = 'race-mixed@example.com';
  const correctCode = '333444';
  const { supabase, rows } = createFakeSignupRpcSupabase([
    { id: 'race3', email, code_hash: hashKey(correctCode), expires_at: FUTURE, attempts: 0, created_at: new Date().toISOString() },
  ]);

  const codes = Array.from({ length: CONCURRENT_WRONG_GUESS_COUNT }, (_, i) => `wrong-${i}`);
  codes[0] = correctCode; // 197件の誤りに1件だけ正解を混ぜる

  const results = await Promise.all(
    codes.map((code) => verifySignupCode({ supabase, email, code, hashCode: hashKey, maxAttempts: SIGNUP_CODE_MAX_ATTEMPTS }))
  );

  assert.ok(rows.get('race3').attempts <= SIGNUP_CODE_MAX_ATTEMPTS, '試行回数が上限を超えてはならない');
  const successCount = results.filter((r) => r.ok === true).length;
  assert.ok(successCount <= 1, '正解の消費は高々1回分の枠しか使わないため、成功は1件以下のはず');
});

// ============================================================
// AC-L5-10: request-code のクールダウンが並行アクセス下でも守られる
// ============================================================
// セキュリティ監査PoCでは、1周目の実装（read-modify-write）に同時500件のrequest-codeを
// 送ると、429が0件、被害者に500通のメールが届くことが実測された。
// 本物のrequestSignupCode（RPCベースの是正後の実装）に対して同じ規模の並行リクエストを
// 発生させ、クールダウン中に受理される（＝メール送信対象になる）のが1件だけであることを
// 検証する。
const CONCURRENT_REQUEST_CODE_COUNT = 500; // 監査PoCと同じ規模（同時500件）

test('AC-L5-10: 同時500件のrequest-codeを送っても、クールダウン中に受理されるのは1件だけ（想定を超えるメールが送信されない）', async () => {
  const email = 'flood-target@example.com';
  const { supabase, rows } = createFakeSignupRpcSupabase([]);

  const results = await Promise.all(
    Array.from({ length: CONCURRENT_REQUEST_CODE_COUNT }, (_, i) =>
      requestSignupCode({
        supabase,
        email,
        name: '店舗',
        codeHash: hashKey(`code-${i}`),
        expiresAt: FUTURE,
        cooldownSeconds: 60, // server.jsの実際のSIGNUP_CODE_RESEND_COOLDOWN_SECONDSと同じ値
      })
    )
  );

  // 【AC-L5-10の核心】500件同時に投げても、accepted:true（＝メール送信してよい）になるのは
  // 1件だけ。1周目の実装ではここが全件通過し、被害者に500通のメールが届いていた。
  const acceptedCount = results.filter((r) => r.accepted === true).length;
  assert.strictEqual(acceptedCount, 1);
  // pending_signupsには被害者のメールアドレスの行が1件だけ残る（emailの一意インデックス相当）。
  const rowsForEmail = [...rows.values()].filter((r) => r.email === email);
  assert.strictEqual(rowsForEmail.length, 1);
});

// ============================================================
// AC-L5-14: request_signup_code RPCが想定外に空を返した場合のfail-closed動作
// ============================================================
// lib/signup.js の requestSignupCode は、RPCが行を返さなかった場合
// （null / 空配列[] / undefined。本来のRPC実装なら起こらないはずだが、
// 将来の実装変更やエラーハンドリングの不備で発生しうる）、
// 安全側（fail-closed）に倒してクールダウン中として扱う設計になっている
// （accepted: false, retryAfterSeconds: cooldownSeconds を返す）。
//
// 計画担当のミューテーションテストで、この分岐を accepted: true（fail-open）に
// 書き換えても既存94件のテストが1件も落ちないことが指摘された
// （createFakeSignupRpcSupabase の request_signup_code は常にresponseRowを返す実装のため、
// この空応答の経路自体を通過するテストがそもそも存在しなかった）。
// ここでは他のフェイクを使わず、直接「空を返すRPC」を模した最小のsupabaseスタブで
// この分岐そのものを狙い撃ちして検証する。
test('AC-L5-14: request_signup_code RPCがnullを返した場合、fail-closedでaccepted:falseになりcooldownSecondsがそのまま返る', async () => {
  const supabase = { rpc: async () => ({ data: null, error: null }) };
  const result = await requestSignupCode({
    supabase,
    email: 'empty-response-null@example.com',
    name: '店舗',
    codeHash: hashKey('000000'),
    expiresAt: FUTURE,
    cooldownSeconds: 60,
  });
  assert.strictEqual(result.accepted, false);
  assert.strictEqual(result.retryAfterSeconds, 60);
});

test('AC-L5-14: request_signup_code RPCが空配列[]を返した場合、fail-closedでaccepted:falseになる', async () => {
  const supabase = { rpc: async () => ({ data: [], error: null }) };
  const result = await requestSignupCode({
    supabase,
    email: 'empty-response-array@example.com',
    name: '店舗',
    codeHash: hashKey('000000'),
    expiresAt: FUTURE,
    cooldownSeconds: 90,
  });
  assert.strictEqual(result.accepted, false);
  assert.strictEqual(result.retryAfterSeconds, 90);
});

test('AC-L5-14: request_signup_code RPCがundefinedを返した場合、fail-closedでaccepted:falseになる', async () => {
  const supabase = { rpc: async () => ({ data: undefined, error: null }) };
  const result = await requestSignupCode({
    supabase,
    email: 'empty-response-undefined@example.com',
    name: '店舗',
    codeHash: hashKey('000000'),
    expiresAt: FUTURE,
    cooldownSeconds: 30,
  });
  assert.strictEqual(result.accepted, false);
  assert.strictEqual(result.retryAfterSeconds, 30);
});

// --- isSignupCodeMatch（純粋関数。ハッシュ比較のみを担う）そのものの単体テスト ---
// 存在確認・期限切れ確認・試行回数の上限判定はすべてSQL側(RPC)で完了しているため、
// この関数の責務はハッシュ比較のみに縮小されている（SECURITY_REVIEW_L5.md 高-1の
// 修正案「純粋関数としてのテスタビリティを残したいなら、ハッシュ比較のみを担う関数に
// 縮小する」に対応）。

test('正常系: pendingが存在し、コードが一致すればtrueになる', () => {
  const pending = { id: 'x1', code_hash: hashKey('123123') };
  assert.strictEqual(isSignupCodeMatch({ pending, code: '123123', hashCode: hashKey }), true);
});

test('異常系: pendingが存在しない場合はfalseになる（RPCが枠を消費できなかった場合を模す）', () => {
  assert.strictEqual(isSignupCodeMatch({ pending: null, code: '123123', hashCode: hashKey }), false);
});

test('異常系: pendingは存在するがコードが一致しない場合はfalseになる', () => {
  const pending = { id: 'x2', code_hash: hashKey('123123') };
  assert.strictEqual(isSignupCodeMatch({ pending, code: '999999', hashCode: hashKey }), false);
});
