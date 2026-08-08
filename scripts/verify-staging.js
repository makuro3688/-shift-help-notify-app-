#!/usr/bin/env node
'use strict';

/**
 * scripts/verify-staging.js
 *
 * L-5（確認コード総当たり対策）の実機検証スクリプト。
 * これまで PostgreSQL が一度も実行できておらず（サンドボックスにDBが無いため）、
 * RPC (consume_signup_attempt / request_signup_code) の挙動はテスト107件のどれも
 * 検証できていなかった。実際、独立監査（SECURITY_REVIEW_L5_FINAL2.md 中-1）は
 * テスト全通過をすり抜けるリリースブロッカー（RPC内の列名衝突）を発見している。
 * 本スクリプトは、ユーザーが用意した検証用Supabaseプロジェクト（本番とは別）に対して
 * 実際にRPCを実行し、次の4点を確認する。
 *
 *   AC-V1: 正しい確認コードで店舗登録が完走する（500にならない＝中-1是正の確認）
 *   AC-V2: 正しいコードを同時5本投げても、作成される店舗は1件だけ（中-A是正の確認）
 *   AC-V3: 不正なボディを300回投げても、その後の正規リクエストが429にならない（中-B是正の確認）
 *   AC-V4: anonキーからRPC・全テーブルの読み書きができない（権限設定の確認）
 *
 * 【実行者】このスクリプトはユーザーが自分のPCで実行する（node scripts/verify-staging.js）。
 * 実機（Supabaseの鍵）が無い環境では実行できないため、ここでは構文チェックと
 * 「.env.stagingが無い/不十分なときに安全に終了すること」のみを検証している。
 *
 * 【変更禁止】server.js / lib/ / supabase/setup.sql / test/ には一切手を加えていない。
 * このファイルは新規追加のみ。server.js が export する buildApp() を使ってアプリを
 * プロセス内に組み立て、実際のHTTPリクエストとして叩く（server.js内の実装をコピーしない）。
 *
 * 【安全装置(AC-V5)】本番に対して誤実行されると、不要な店舗が作られたり
 * レート制限の枠が消費されたりする。以下をすべて満たさない限り何もせず終了する。
 *   1. .env.staging が存在する（.env は絶対に読まない＝明示的にrequireしない）
 *   2. STAGING_CONFIRMED=yes が設定されている
 *   3. PRODUCTION_SUPABASE_URL が設定されている場合、SUPABASE_URLと一致しないこと
 *   4. 実行前に stores の件数を数え、STORE_COUNT_ABORT_THRESHOLD件以上なら中断する
 *   5. 接続先のSUPABASE_URLを表示し、ユーザーに "yes" の入力を求める（--yesで省略可）
 * 鍵そのもの（SUPABASE_SERVICE_KEY / SUPABASE_ANON_KEY / RESEND_API_KEY）は
 * このスクリプトのどこでも画面出力・ログ出力しない。
 *
 * 【後片付け(AC-V6)】作成するデータは店舗名を "__verify_<timestamp>_<label>"、
 * メールアドレスを "verify+<timestamp>-<label>@example.test"
 * （example.test はRFC 2606の予約ドメインで実在せず、実際にメールが飛ぶ心配がない）で
 * タグ付けする。起動時（冪等性のため）と終了時（try/finallyで必ず）の両方で、
 * このタグに一致するデータだけを削除する。既存データのidは一切扱わないため、
 * 既存データを誤って削除することはない。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const readline = require('readline');
const dotenv = require('dotenv');

// --- 名前付き定数（マジックナンバー回避） ---

// 「本番ではないか」を疑うための閾値（安全装置#4）。検証用DBは基本的に空に近いはずなので、
// 10件も店舗があれば本番の可能性が高いと判断して中断する。
const STORE_COUNT_ABORT_THRESHOLD = 10;

// AC-V2: 正しいコードを同時に何本投げるか（中-Aが検証したかった「同時5本」に合わせる）
const AC_V2_CONCURRENCY = 5;

// AC-V3: 送りつける不正ボディの回数。監査人が指摘した攻撃（30IP×10回=300回）と同じ総数を、
// IP制限だけを緩めた1台のアプリから再現する。
const AC_V3_INVALID_REQUEST_COUNT = 300;

// AC-V3: IP単位のリミッタを「実質無制限」にするための上限値。
// 300回の不正リクエストより十分大きく、かつ通常のJS数値として安全な範囲。
const AC_V3_LOOSE_IP_LIMIT_MAX_REQUESTS = 1_000_000;
const AC_V3_LOOSE_IP_LIMIT_WINDOW_MS = 60 * 60 * 1000; // 1時間（値自体は上限が実質無制限なので意味を持たない）

// pending_signups に直接投入する行の有効期限。server.js の SIGNUP_CODE_TTL_MINUTES と同じ値。
const PENDING_SIGNUP_TTL_MINUTES = 15;

// 検証データの識別用タグ（実在しないRFC 2606予約ドメインを使うことで、
// 誤って実際のメールアドレス宛てにメールが飛ぶ事故を構造的に防ぐ）。
const VERIFY_EMAIL_PREFIX = 'verify+';
const VERIFY_EMAIL_DOMAIN = 'example.test';
const VERIFY_NAME_PREFIX = '__verify_';

// .env.staging のパス（.env ではない。誤って本番の .env を読まないよう、パスを明示指定する）
const ENV_STAGING_PATH = path.join(__dirname, '..', '.env.staging');

// AC-V4 で叩く対象テーブル一覧。supabase/setup.sql の create table を全行読んで確認した
// 実際の9テーブル（推測ではなく実ファイルから書き起こし）。
const ALL_TABLES = [
  'stores',
  'supervisor_keys',
  'pending_signups',
  'subscriptions',
  'shifts',
  'app_config',
  'stripe_events',
  'used_emails',
  'reports',
];

// --- ユーティリティ ---

// server.js:250-252 の hashKey と完全に同じ実装（SHA-256のhex表現）。
// pending_signups.code_hash はこの関数で作られた値としか一致しないため、
// サーバー側と別のハッシュ関数を使うと絶対に検証が通らない。
function hashKeySame(key) {
  return crypto.createHash('sha256').update(key).digest('hex');
}

// server.js:255-257 の generateSignupCode と同じ6桁コード生成（値そのものは
// このスクリプトがハッシュ化して直接DBに入れるので何でもよいが、実装を揃えておく）。
function generateCode() {
  return String(crypto.randomInt(100000, 1000000));
}

// 今回の実行を識別するタグ（後片付け・冪等性のため、店舗名とメールアドレスに埋め込む）
function makeTagger(runTag) {
  return {
    email(label) {
      return `${VERIFY_EMAIL_PREFIX}${runTag}-${label}@${VERIFY_EMAIL_DOMAIN}`;
    },
    name(label) {
      return `${VERIFY_NAME_PREFIX}${runTag}_${label}`;
    },
  };
}

function tally(arr) {
  const t = {};
  for (const v of arr) t[v] = (t[v] || 0) + 1;
  return t;
}

function safeJsonParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// 標準入力から yes/no の確認を取る。非対話環境（パイプ等）でストリームが
// 入力なしに閉じた場合でもハングしないよう、close イベントでも解決する（fail-closed：
// 何も入力が無ければ「yes」以外＝拒否として扱われる）。
function askYesNo(promptText) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    let answered = false;
    rl.question(promptText, (answer) => {
      answered = true;
      rl.close();
      resolve(answer);
    });
    rl.on('close', () => {
      if (!answered) resolve('');
    });
  });
}

// Expressアプリをランダムな空きポート(127.0.0.1)で待受させ、baseUrlを返す。
// Renderへのデプロイもapp.listen()も本番副作用を持たずに、実際のHTTPリクエストとして
// server.jsのハンドラを叩ける（server.js内の実装をJSでコピーして検証する構造を避けるため）。
function startServer(app) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, baseUrl: `http://127.0.0.1:${port}` });
    });
    server.on('error', reject);
  });
}

function stopServer(server) {
  return new Promise((resolve) => server.close(() => resolve()));
}

// verify-code / request-code のどちらでも呼ばれることのないダミー送信関数。
// 【重要】実際のメールは絶対に送らない。overrides.sendSignupCodeEmail で全アプリに適用する。
async function dummySendEmail(/* email, code */) {
  // 検証用ダミー：何もしない
}

// --- .env.staging のテンプレート案内（ファイルが無いときに表示して正常終了する） ---
function printEnvTemplateGuide() {
  console.log(
    [
      '',
      `.env.staging が見つかりません（${ENV_STAGING_PATH}）。`,
      'このファイルは .env とは別の、検証専用の設定ファイルです（本番設定と混ざらないようにするため）。',
      '以下の内容でファイルを作成してから、もう一度このスクリプトを実行してください。',
      '',
      '------------------------------------------------------------',
      'SUPABASE_URL=https://xxxxx.supabase.co',
      'SUPABASE_SERVICE_KEY=(検証用プロジェクトの service_role キー)',
      'SUPABASE_ANON_KEY=(検証用プロジェクトの anon キー)',
      'RESEND_API_KEY=dummy-not-used',
      'VAPID_CONTACT_EMAIL=test@example.com',
      'STAGING_CONFIRMED=yes',
      'PRODUCTION_SUPABASE_URL=(任意。本番のProject URLを入れておくと誤実行防止になります)',
      '------------------------------------------------------------',
      '',
      '注意:',
      '- SUPABASE_URL / SUPABASE_SERVICE_KEY / SUPABASE_ANON_KEY は、本番とは別に作った',
      '  検証用Supabaseプロジェクトの Project Settings > API から取得してください。',
      '- service_role キーは本番と同じ強い権限を持ちます。チャットや他人に絶対に共有しないでください。',
      '- RESEND_API_KEY は実際には使いません（メール送信はダミー関数に差し替えるため）が、',
      '  未設定だとサーバー側の存在チェックで弾かれるためダミー値を入れてください。',
      '- .env.staging は .gitignore（.env.* パターン）で除外され、gitにコミットされません。',
      '',
    ].join('\n')
  );
}

// --- 後片付け（起動時の冪等クリーンアップ・終了時の後片付けの両方で使う共通処理） ---
// タグ（店舗名の __verify_ 接頭辞 / メールアドレスの verify+...@example.test）に一致する
// データだけを対象にする。実行のたびにタイムスタンプが変わるため、このタグ一致条件は
// 「過去の失敗した実行で残ったデータ」も「今回作ったデータ」も両方拾う＝冪等になる。
// 既存データ（タグに一致しないもの）には一切触れない。
async function cleanupTaggedData(supabase) {
  const result = { stores: 0, pendingSignups: 0 };

  // stores: 店舗名 or メールアドレスのどちらかがタグに一致するもの
  const [byName, byEmail] = await Promise.all([
    supabase.from('stores').select('id').like('name', `${VERIFY_NAME_PREFIX}%`),
    supabase.from('stores').select('id').like('email', `${VERIFY_EMAIL_PREFIX}%@${VERIFY_EMAIL_DOMAIN}`),
  ]);
  const storeIds = new Set();
  for (const r of byName.data || []) storeIds.add(r.id);
  for (const r of byEmail.data || []) storeIds.add(r.id);
  if (storeIds.size > 0) {
    const { error } = await supabase.from('stores').delete().in('id', Array.from(storeIds));
    if (!error) result.stores = storeIds.size;
  }

  // pending_signups: メールアドレスがタグに一致するもの（照合成功時はRPCが既に削除しているが、
  // 失敗して残ったままの行や、まだ照合していない行を拾う）
  const { data: pendingRows } = await supabase
    .from('pending_signups')
    .select('id')
    .like('email', `${VERIFY_EMAIL_PREFIX}%@${VERIFY_EMAIL_DOMAIN}`);
  if (pendingRows && pendingRows.length > 0) {
    const ids = pendingRows.map((r) => r.id);
    const { error } = await supabase.from('pending_signups').delete().in('id', ids);
    if (!error) result.pendingSignups = ids.length;
  }

  return result;
}

// pending_signups に、サーバーと同じハッシュ関数で既知のコードを直接投入する。
// 確認コードは生の値がメールにしか残らないため、自動検証では「サーバーと同じ方法で
// ハッシュ化した既知のコード」をservice_roleで直接投入する（検証したいのはverify-code側の
// 挙動なので、これで目的を果たせる。行動計画書 6章参照）。
async function insertPendingSignup(supabase, { email, name, code }) {
  const codeHash = hashKeySame(code);
  const expiresAt = new Date(Date.now() + PENDING_SIGNUP_TTL_MINUTES * 60 * 1000).toISOString();
  const { data, error } = await supabase
    .from('pending_signups')
    .insert({ email, name, code_hash: codeHash, expires_at: expiresAt, attempts: 0 })
    .select()
    .single();
  if (error) {
    throw new Error(`pending_signups への投入に失敗しました: ${error.message}`);
  }
  return data;
}

// --- AC-V1: 正しいコードで店舗登録が完走する（中-1是正の検証） ---
async function runAcV1({ supabase, buildApp, tagger }) {
  const id = 'AC-V1';
  const label = '正しいコードで登録が完走';
  const email = tagger.email('v1');
  const name = tagger.name('v1');
  const code = generateCode();

  await insertPendingSignup(supabase, { email, name, code });

  // buildApp(overrides) の overrides.supabase / overrides.sendSignupCodeEmail は
  // server.js:375-376,566 で定義されている実際のキー名（推測ではなく読んで確認済み）。
  const app = buildApp({ supabase, sendSignupCodeEmail: dummySendEmail });
  const { server, baseUrl } = await startServer(app);
  try {
    const res = await fetch(`${baseUrl}/api/signup/verify-code`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, code }),
    });
    const bodyText = await res.text();
    const bodyJson = safeJsonParse(bodyText);

    if (res.status === 500) {
      return {
        id,
        label,
        pass: false,
        summary: '500が返りました（不合格）',
        detail: `HTTPステータス: 500\nレスポンス本文: ${bodyText}`,
      };
    }
    // server.js:726 は成功時に res.status(201) を返す（行動計画書の記述「200」は概要であり、
    // 実際のコードを読んで確認したところ201が正しい。本スクリプトは実装どおり201を判定に使う）。
    if (res.status !== 201) {
      return {
        id,
        label,
        pass: false,
        summary: `期待した201ではなくHTTP ${res.status}が返りました`,
        detail: `HTTPステータス: ${res.status}\nレスポンス本文: ${bodyText}`,
      };
    }
    if (!bodyJson || !bodyJson.adminKey || !bodyJson.storeId) {
      return {
        id,
        label,
        pass: false,
        summary: '201は返りましたが管理者キー/storeIdが含まれていません',
        detail: `レスポンス本文: ${bodyText}`,
      };
    }

    const { data: storeRow, error: selErr } = await supabase
      .from('stores')
      .select('id, name, email')
      .eq('id', bodyJson.storeId)
      .maybeSingle();
    if (selErr || !storeRow) {
      return {
        id,
        label,
        pass: false,
        summary: 'storesに実際の行が見つかりませんでした',
        detail: `select error: ${selErr ? selErr.message : '(no row)'}`,
      };
    }

    return {
      id,
      label,
      pass: true,
      summary: '',
      detail: `店舗作成成功（storeId=${storeRow.id}, HTTP 201, 管理者キー発行を確認）`,
    };
  } finally {
    await stopServer(server);
  }
}

// --- AC-V2: 同時5本でも店舗は1件だけ（中-A是正の検証） ---
async function runAcV2({ supabase, buildApp, tagger }) {
  const id = 'AC-V2';
  const label = '同時5本でも店舗は1件だけ';
  const email = tagger.email('v2');
  const name = tagger.name('v2');
  const code = generateCode();

  await insertPendingSignup(supabase, { email, name, code });

  const app = buildApp({ supabase, sendSignupCodeEmail: dummySendEmail });
  const { server, baseUrl } = await startServer(app);
  try {
    const requests = Array.from({ length: AC_V2_CONCURRENCY }, () =>
      fetch(`${baseUrl}/api/signup/verify-code`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, code }),
      }).then(async (r) => ({ status: r.status, body: await r.text() }))
    );
    const results = await Promise.all(requests);
    const successes = results.filter((r) => r.status === 201);

    // DB側の実際の行数も突き合わせる（レスポンスの数え間違いを避けるための二重チェック）
    const { count, error: cntErr } = await supabase
      .from('stores')
      .select('*', { count: 'exact', head: true })
      .eq('email', email);
    if (cntErr) {
      return {
        id,
        label,
        pass: false,
        summary: 'stores件数の確認に失敗しました',
        detail: `select error: ${cntErr.message}`,
      };
    }

    if (successes.length !== 1 || count !== 1) {
      return {
        id,
        label,
        pass: false,
        summary: `成功${successes.length}件・storesは${count}件作成されました（1件だけであるべき）`,
        detail: `各レスポンスのステータス: ${JSON.stringify(results.map((r) => r.status))}\n各本文: ${JSON.stringify(
          results.map((r) => r.body)
        )}`,
      };
    }

    return {
      id,
      label,
      pass: true,
      summary: '',
      detail: `同時${AC_V2_CONCURRENCY}本中、成功は1本のみ・storesは1件だけ作成されました`,
    };
  } finally {
    await stopServer(server);
  }
}

// --- AC-V3: 不正リクエストがグローバル枠を消費しない（中-B是正の検証） ---
async function runAcV3({ supabase, buildApp, createRateLimiter, tagger }) {
  const id = 'AC-V3';
  const label = '不正リクエストが枠を消費しない';

  // 【検証の意図（重要）】現在のIP単位制限は1時間10通。1台のPCから300回投げると
  // 11回目でIP制限に当たり、検証したいグローバル枠の挙動を確認できない。
  // 監査人が指摘した攻撃は「30IP×10回」だった。そこでIP単位のリミッタだけを
  // 実質無制限に差し替えたアプリを別途組み立て、メール単位・グローバル単位の
  // レート制限は server.js のモジュールスコープにある本物の関数（overridesを渡さない
  // ため isRequestCodeAllowedByEmail / isRequestCodeAllowedGlobally がそのまま使われる。
  // server.js:560-562,634-636参照）で検証する。
  const looseIpLimiter = createRateLimiter(AC_V3_LOOSE_IP_LIMIT_WINDOW_MS, AC_V3_LOOSE_IP_LIMIT_MAX_REQUESTS);

  const app = buildApp({
    supabase,
    requestCodeIpLimiter: looseIpLimiter, // ← IP単位だけ緩める
    sendSignupCodeEmail: dummySendEmail, // ← 実際のメールは絶対に送らない
    // requestCodeEmailLimiter / requestCodeGlobalLimiter は意図的に渡さない
    // （＝本物のグローバル枠・メール単位枠のまま検証する）
  });
  const { server, baseUrl } = await startServer(app);
  try {
    const invalidStatuses = [];
    for (let i = 0; i < AC_V3_INVALID_REQUEST_COUNT; i++) {
      const res = await fetch(`${baseUrl}/api/signup/request-code`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'x' }), // name無しの不正ボディ。仕様の例と同じ
      });
      invalidStatuses.push(res.status);
    }
    const invalidTally = tally(invalidStatuses);

    const legitEmail = tagger.email('v3');
    const legitName = tagger.name('v3');
    const legitRes = await fetch(`${baseUrl}/api/signup/request-code`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: legitName, email: legitEmail }),
    });
    const legitBody = await legitRes.text();

    if (legitRes.status === 429) {
      return {
        id,
        label,
        pass: false,
        summary: '不正リクエスト300回の後、正規リクエストが429になりました（グローバル枠が消費された）',
        detail: `不正リクエストのステータス内訳: ${JSON.stringify(invalidTally)}\n正規リクエストのHTTPステータス: ${
          legitRes.status
        }\n正規リクエストの本文: ${legitBody}`,
      };
    }

    return {
      id,
      label,
      pass: true,
      summary: '',
      detail: `不正リクエスト${AC_V3_INVALID_REQUEST_COUNT}回のステータス内訳: ${JSON.stringify(
        invalidTally
      )}\nその後の正規リクエストはHTTP ${legitRes.status}で受理されました（429ではない）`,
    };
  } finally {
    await stopServer(server);
  }
}

// --- AC-V4: anonキーからアクセスできない ---
async function runAcV4({ supabaseUrl, anonKey }) {
  const id = 'AC-V4';
  const label = 'anon からアクセスできない';
  const details = [];
  const failures = [];

  const authHeaders = {
    apikey: anonKey,
    Authorization: `Bearer ${anonKey}`,
    'Content-Type': 'application/json',
  };

  // 1. RPC 2つが anon から拒否されること
  const rpcProbes = [
    {
      name: 'consume_signup_attempt',
      body: { p_email: 'anon-probe@example.test', p_max: 999999, p_code_hash: 'x'.repeat(64) },
    },
    {
      name: 'request_signup_code',
      body: {
        p_email: 'anon-probe@example.test',
        p_name: 'x',
        p_code_hash: 'x'.repeat(64),
        p_expires_at: new Date().toISOString(),
        p_cooldown_seconds: 0,
      },
    },
  ];
  for (const probe of rpcProbes) {
    const res = await fetch(`${supabaseUrl}/rest/v1/rpc/${probe.name}`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify(probe.body),
    });
    const text = await res.text();
    const rejected = res.status < 200 || res.status >= 300;
    if (!rejected) failures.push(`RPC ${probe.name}`);
    details.push(`RPC ${probe.name}: HTTP ${res.status}${rejected ? '（拒否・合格）' : '（成功してしまった・不合格）'} 本文: ${text.slice(0, 300)}`);
  }

  // 2. 全9テーブルの GET が拒否されること
  for (const table of ALL_TABLES) {
    const res = await fetch(`${supabaseUrl}/rest/v1/${table}?select=*`, {
      headers: { apikey: anonKey, Authorization: `Bearer ${anonKey}` },
    });
    const text = await res.text();
    const rejected = res.status < 200 || res.status >= 300;
    if (!rejected) failures.push(`GET ${table}`);
    details.push(`GET ${table}: HTTP ${res.status}${rejected ? '（拒否・合格）' : '（成功してしまった・不合格）'} 本文: ${text.slice(0, 300)}`);
  }

  // 3. stores への INSERT / UPDATE も拒否されること（admin_key_hash書き換え＝権限奪取の防止確認）
  const insertRes = await fetch(`${supabaseUrl}/rest/v1/stores`, {
    method: 'POST',
    headers: { ...authHeaders, Prefer: 'return=representation' },
    body: JSON.stringify({
      name: `${VERIFY_NAME_PREFIX}ac_v4_insert_should_be_rejected`,
      admin_key_hash: `should_never_land_${Date.now()}`,
    }),
  });
  const insertText = await insertRes.text();
  const insertRejected = insertRes.status < 200 || insertRes.status >= 300;
  if (!insertRejected) failures.push('INSERT stores');
  details.push(
    `INSERT stores: HTTP ${insertRes.status}${insertRejected ? '（拒否・合格）' : '（成功してしまった・不合格！要即対応）'} 本文: ${insertText.slice(0, 300)}`
  );

  // UPDATE: 実在しないUUIDを対象にする。権限（REVOKE）はテーブル単位で効くため、
  // 対象行が0件でも「文そのものが実行できるか」を確認するにはこれで十分。
  // 既存データ（AC-V1/V2が作った検証用店舗を含む）を一切対象にしないための安全策でもある。
  const NON_EXISTENT_UUID = '00000000-0000-0000-0000-000000000000';
  const updateRes = await fetch(`${supabaseUrl}/rest/v1/stores?id=eq.${NON_EXISTENT_UUID}`, {
    method: 'PATCH',
    headers: authHeaders,
    body: JSON.stringify({ admin_key_hash: `should_never_land_${Date.now()}` }),
  });
  const updateText = await updateRes.text();
  const updateRejected = updateRes.status < 200 || updateRes.status >= 300;
  if (!updateRejected) failures.push('UPDATE stores');
  details.push(
    `UPDATE stores: HTTP ${updateRes.status}${updateRejected ? '（拒否・合格）' : '（成功してしまった・不合格！要即対応）'} 本文: ${updateText.slice(0, 300)}`
  );

  return {
    id,
    label,
    pass: failures.length === 0,
    summary: failures.length === 0 ? '' : `以下が拒否されず通ってしまいました: ${failures.join(', ')}`,
    detail: details.join('\n    '),
  };
}

function printSummary(results) {
  console.log('\n============ 検証結果 ============');
  for (const r of results) {
    const verdict = r.pass ? '[合格]' : '[不合格]';
    const line = r.summary ? `${r.id}  ${r.label}  ${verdict} ${r.summary}` : `${r.id}  ${r.label}  ${verdict}`;
    console.log(line);
    console.log(`    ${r.detail}`);
  }
  const failCount = results.filter((r) => !r.pass).length;
  console.log('==================================');
  if (failCount > 0) {
    console.log(`不合格 ${failCount}件。詳細は上のログを参照してください。`);
  } else {
    console.log('全項目 合格しました。');
  }
}

async function main() {
  // --- 安全装置1: .env.staging が存在すること（.env は絶対に読まない＝この関数内でも
  // .env というファイル名は一度も参照しない） ---
  if (!fs.existsSync(ENV_STAGING_PATH)) {
    printEnvTemplateGuide();
    return; // 何もせず正常終了（exit code 0）
  }

  const loaded = dotenv.config({ path: ENV_STAGING_PATH });
  if (loaded.error) {
    console.error(`[中断] .env.staging の読み込みに失敗しました: ${loaded.error.message}`);
    process.exitCode = 1;
    return;
  }

  const REQUIRED_VARS = [
    'SUPABASE_URL',
    'SUPABASE_SERVICE_KEY',
    'SUPABASE_ANON_KEY',
    'RESEND_API_KEY',
    'VAPID_CONTACT_EMAIL',
    'STAGING_CONFIRMED',
  ];
  const missing = REQUIRED_VARS.filter((k) => !process.env[k]);
  if (missing.length > 0) {
    console.error(`[中断] .env.staging に以下の変数が設定されていません: ${missing.join(', ')}`);
    console.error('（.env.staging の書き方は、このスクリプトを一度削除してから再実行すると案内が表示されます）');
    process.exitCode = 1;
    return;
  }

  // --- 安全装置2: STAGING_CONFIRMED=yes ---
  if (process.env.STAGING_CONFIRMED !== 'yes') {
    console.error('[中断] STAGING_CONFIRMED=yes が設定されていません。安全のため何もせず終了します。');
    process.exitCode = 1;
    return;
  }

  const supabaseUrl = process.env.SUPABASE_URL.trim();

  // --- 安全装置3: PRODUCTION_SUPABASE_URL と一致しないこと ---
  const prodUrl = (process.env.PRODUCTION_SUPABASE_URL || '').trim();
  if (prodUrl && prodUrl === supabaseUrl) {
    console.error('[中断] SUPABASE_URL が PRODUCTION_SUPABASE_URL と同一です。');
    console.error('本番環境に対して実行しようとしている可能性が高いため、何もせず中断します。');
    process.exitCode = 1;
    return;
  }

  // .gitignore が .env.staging を確実に除外しているかの簡易確認（見つからなければ警告のみ）
  try {
    const gitignore = fs.readFileSync(path.join(__dirname, '..', '.gitignore'), 'utf8');
    if (!/\.env\.staging|\.env\.\*|\.env\*/.test(gitignore)) {
      console.warn('[警告] .gitignore に .env.staging を除外するパターンが見つかりませんでした。');
      console.warn('service_role キーが誤ってgitにコミットされないよう、事前に確認してください。');
    }
  } catch {
    // .gitignore自体が読めなくても検証は継続する（致命的ではないため警告のみ省略）
  }

  // ここまでで環境変数の安全確認が完了。server.js を require する。
  // 【重要】server.js冒頭には require('dotenv').config() があるが、dotenvは既に
  // process.envに設定済みの値を上書きしない既定動作のため、上で読み込んだ
  // .env.staging の値（SUPABASE_URL等）が本物の .env の値で上書きされることはない。
  // ただし .env.staging に無い変数（STRIPE_SECRET_KEY等）がもしカレントディレクトリの
  // .env にあれば読み込まれる可能性がある。今回の4項目には影響しないため許容する。
  let buildApp;
  let createRateLimiter;
  let createClient;
  try {
    ({ buildApp } = require('../server'));
    ({ createRateLimiter } = require('../lib/rateLimit'));
    ({ createClient } = require('@supabase/supabase-js'));
  } catch (err) {
    console.error('[中断] server.js の読み込みに失敗しました。buildApp が export されているか確認してください。');
    console.error(String((err && err.stack) || err));
    process.exitCode = 1;
    return;
  }

  const supabase = createClient(supabaseUrl, process.env.SUPABASE_SERVICE_KEY);

  // --- 安全装置4: stores が10件以上なら中断 ---
  const { count: storeCount, error: countErr } = await supabase.from('stores').select('*', { count: 'exact', head: true });
  if (countErr) {
    console.error(`[中断] stores テーブルの件数取得に失敗しました: ${countErr.message}`);
    console.error('supabase/setup.sql が正しく適用されているか、SUPABASE_SERVICE_KEY が正しいか確認してください。');
    process.exitCode = 1;
    return;
  }
  if (storeCount >= STORE_COUNT_ABORT_THRESHOLD) {
    console.error(`[中断] stores テーブルに ${storeCount} 件のデータがあります（閾値: ${STORE_COUNT_ABORT_THRESHOLD}件）。`);
    console.error('本番環境ではありませんか？ 検証用の（本番とは別の）Supabaseプロジェクトであることを確認してから、');
    console.error('もし正しく検証用プロジェクトであれば、この閾値を見直すか計画担当に相談してください。');
    process.exitCode = 1;
    return;
  }

  // --- 安全装置5: 接続先URLの表示 + ユーザー確認（鍵は絶対に表示しない） ---
  console.log(`接続先 SUPABASE_URL: ${supabaseUrl}`);
  console.log(`（鍵はこの画面に表示しません。現在の stores 件数: ${storeCount}件）`);

  const skipPrompt = process.argv.slice(2).includes('--yes');
  if (skipPrompt) {
    console.log('（--yes が指定されたため、確認プロンプトを省略します）');
  } else {
    const answer = await askYesNo('この接続先に対して検証を実行します。よろしいですか？ ("yes" と入力してEnter): ');
    if (answer.trim() !== 'yes') {
      console.error('[中断] 確認が得られなかったため終了します（何も実行していません）。');
      process.exitCode = 1;
      return;
    }
  }

  const runTag = Date.now();
  const tagger = makeTagger(runTag);
  const results = [];

  try {
    // 起動時クリーンアップ（冪等性）：前回の実行が途中で落ちていた場合の残骸を先に消す
    const preCleanup = await cleanupTaggedData(supabase);
    console.log(
      `起動時クリーンアップ: 過去の検証データを stores=${preCleanup.stores}件, pending_signups=${preCleanup.pendingSignups}件 削除しました`
    );

    results.push(await runAcV1({ supabase, buildApp, tagger }));
    results.push(await runAcV2({ supabase, buildApp, tagger }));
    results.push(await runAcV3({ supabase, buildApp, createRateLimiter, tagger }));
    results.push(await runAcV4({ supabaseUrl, anonKey: process.env.SUPABASE_ANON_KEY }));
  } catch (err) {
    console.error('検証中に予期しないエラーが発生しました:', err);
    results.push({
      id: '実行エラー',
      label: '検証スクリプト自体の異常終了',
      pass: false,
      summary: String((err && err.message) || err),
      detail: String((err && err.stack) || err),
    });
  } finally {
    // 途中でエラーが起きても必ず後片付けする（try/finally）
    try {
      const postCleanup = await cleanupTaggedData(supabase);
      console.log(
        `後片付け: 今回の検証データを stores=${postCleanup.stores}件, pending_signups=${postCleanup.pendingSignups}件 削除しました`
      );
    } catch (cleanupErr) {
      console.error('[警告] 後片付けに失敗しました。手動で確認してください:', cleanupErr);
      console.error(
        `手がかり: stores.name / pending_signups.email が "${VERIFY_NAME_PREFIX}" または "${VERIFY_EMAIL_PREFIX}...@${VERIFY_EMAIL_DOMAIN}" で始まる行`
      );
    }
  }

  printSummary(results);
  process.exitCode = results.some((r) => !r.pass) ? 1 : 0;
}

main().catch((err) => {
  console.error('[中断] スクリプトの実行中に致命的なエラーが発生しました:', err);
  process.exitCode = 1;
});
