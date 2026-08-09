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
 * ============================================================================
 * 【是正履歴（独立監査 SECURITY_REVIEW_検証スクリプト.md への対応・2026-08-09）】
 * 監査人により「実行してはいけない」（高3件／中6件）と判定された。以下すべてを是正した。
 *
 *   高-1: --yes で本番に対して実行できてしまう
 *         → DB側に「検証用DBである目印」（app_config.environment='staging'）を必須にし、
 *           他のどの安全装置よりも先に確認する。--yes でもこれだけは省略できない。
 *   高-2: AC-V3 が実装に関係なく必ず「合格」になる（実測で確認された偽陽性）
 *         → runTagを英字のみにし（数字4桁以上で個人情報バリデーションに誤爆していた）、
 *           判定を「429でないこと」から「期待する200であること」に強化した。
 *   高-3: シェルの環境変数が .env.staging より優先されてしまう
 *         → .env.staging をファイルとして直接parseし、シェルの値との食い違いを検出して
 *           中断、食い違いが無ければ .env.staging の値でprocess.envを明示的に上書きする。
 *   中-1: 後片付けのLIKEの `_` が1文字ワイルドカードで実データに誤爆しうる
 *         → DB側のLIKEは粗い絞り込みに留め、削除前にJS側でstartsWithの厳密一致を再確認する。
 *   中-2: 後片付けがselect/deleteのエラーを握りつぶし、失敗しても「削除しました」と表示する
 *         → エラーを検出したらthrowし、正直に失敗を報告する。
 *   中-3: タグにrunTagが含まれず、他の実行のデータまで削除してしまう
 *         → 終了時の後片付けはrunTagで今回分だけに限定し、起動時の冪等クリーンアップは
 *           「十分に古い（1時間以上前）」データだけを対象にする。
 *   中-4: AC-V4が404や無効なanonキーでも空振り合格になる
 *         → anonキーの有効性を先に疎通確認し、404（テーブル/関数が存在しない）は
 *           「判定不能」として明確に不合格側に倒す。
 *   中-5: server.jsのdotenv.config()がcwdの.envを読む（「.envは読まない」という説明は誤り）
 *         → cwdに.envが存在する場合はserver.jsをrequireする前に検出して中断する。
 *   中-6: 環境エラーが「不合格」と表示され、未実行の項目が一覧に出ない
 *         → 各ACを個別にtry/catchし、「不合格」「検証不能（環境エラー）」「未実行」を
 *           区別して表示する。
 * ============================================================================
 *
 * 【安全装置】本番に対して誤実行されると、不要な店舗が作られたりレート制限の枠が
 * 消費されたりする。以下をすべて満たさない限り何もせず終了する。
 *   0. 接続先DBの app_config テーブルに environment='staging' の行が存在する
 *      （最優先・--yes でもスキップ不可。本番DBにはこの行が存在しない）
 *   1. .env.staging が存在する（.env は絶対に読まない＝明示的にrequireしない）
 *   2. STAGING_CONFIRMED=yes が設定されている
 *   3. PRODUCTION_SUPABASE_URL が設定されている場合、SUPABASE_URLと一致しないこと
 *   4. 実行前に stores の件数を数え、STORE_COUNT_ABORT_THRESHOLD件以上なら中断する
 *   5. 接続先のSUPABASE_URLを表示し、ユーザーに "yes" の入力を求める（--yesで省略可。
 *      ただし装置0は--yesがあっても省略できない）
 * 鍵そのもの（SUPABASE_SERVICE_KEY / SUPABASE_ANON_KEY / RESEND_API_KEY）は
 * このスクリプトのどこでも画面出力・ログ出力しない。
 *
 * 【後片付け】作成するデータは店舗名を "__verify_<runTag>_<label>"、
 * メールアドレスを "verify+<runTag>-<label>@example.test"
 * （example.test はRFC 2606の予約ドメインで実在せず、実際にメールが飛ぶ心配がない）で
 * タグ付けする。起動時（十分に古い残骸だけを対象にした冪等クリーンアップ）と
 * 終了時（今回のrunTagのデータだけを対象にした後片付け・try/finally相当で必ず実行）の
 * 両方で、対象を限定してから削除する。既存データのidは一切扱わないため、
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
// 【重要】この閾値は補助的な多層防御に過ぎない。サービス開始直後の本番はstoresが
// 10件未満のため、この装置だけでは本番を守れない（独立監査 高-1）。本命の防御は
// 安全装置0（app_config.environment='staging'の目印）である。
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

// 【中-3是正】起動時の冪等クリーンアップで「十分に古い」とみなす基準（1時間）。
// 同時に別の検証プロセスが走っている場合、そちらが作ったばかりのデータには触れない。
const PRE_CLEANUP_STALE_MS = 60 * 60 * 1000;

// .env.staging のパス（.env ではない。誤って本番の .env を読まないよう、パスを明示指定する）
const ENV_STAGING_PATH = path.join(__dirname, '..', '.env.staging');

// 【高-3是正】シェルの環境変数と .env.staging の内容が食い違っていないか確認する対象キー。
// この5つは接続先・本番判定に直結するため、シェルに残った値との齟齬を許容できない。
const ENV_CONFLICT_CHECK_KEYS = [
  'SUPABASE_URL',
  'SUPABASE_SERVICE_KEY',
  'SUPABASE_ANON_KEY',
  'PRODUCTION_SUPABASE_URL',
  'STAGING_CONFIRMED',
];

// 【高-1是正】検証用DBであることを示す目印。本番DBにはこの行を絶対に入れないでもらう。
const APP_CONFIG_STAGING_KEY = 'environment';
const APP_CONFIG_STAGING_VALUE = 'staging';
const APP_CONFIG_STAGING_INSERT_SQL = "insert into app_config(key, value) values ('environment', 'staging');";

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

// 【高-2是正】今回の実行を識別するタグを英字のみで生成する。
// 以前は Date.now()（13桁の数字）をそのまま使っており、店舗名に4桁以上の連続した数字が
// 入ってしまっていた。server.js の findPersonalInfoIssue は「合計4桁以上の数字」を
// 電話番号・生年月日等の個人情報とみなして400で拒否するため、AC-V3の「正規リクエスト」が
// リミッタ（429の判定対象）に到達する前に400で弾かれ、AC-V3は実装の中身に関係なく
// 必ず「合格」と表示されていた（監査人が実測で確認した偽陽性）。
function makeRunTag() {
  const ALPHABET = 'abcdefghijklmnopqrstuvwxyz';
  return Array.from(crypto.randomBytes(12), (b) => ALPHABET[b % ALPHABET.length]).join('');
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
      '- さらに、検証用Supabaseプロジェクトの SQL Editor で次を1回実行してください',
      '  （本番DBには絶対に実行しないでください）:',
      `    ${APP_CONFIG_STAGING_INSERT_SQL}`,
      '',
    ].join('\n')
  );
}

// --- 後片付け（起動時の冪等クリーンアップ・終了時の後片付けの両方で使う共通処理） ---
// 【中-1是正】SQLのLIKEにおける `_` は1文字ワイルドカードであり、`__verify_%` は
// 意図しない実データ（例: "ABverifyX Cafe"）にも一致しうる。DB側のLIKEは対象を絞り込む
// ための粗いフィルタに留め、削除前にJS側でstartsWithによる厳密な前方一致を再確認する。
// 【中-3是正】runTagを指定した場合（終了時の後片付け）は「今回の実行が作ったものだけ」を
// 対象にする。runTagを指定せずolderThanMsForStaleを指定した場合（起動時の冪等クリーンアップ）は
// 「十分に古い（既定1時間以上前）」データだけを対象にし、同時に走っている別プロセスの
// データには触れない。
// 【中-2是正】select/deleteのいずれかが失敗した場合は例外をthrowする。呼び出し側で
// 握りつぶさず、「削除できていない」ことを正直にユーザーへ伝える。
async function cleanupTaggedData(supabase, { runTag = null, olderThanMsForStale = null } = {}) {
  const result = { stores: 0, pendingSignups: 0 };

  const namePrefix = runTag ? `${VERIFY_NAME_PREFIX}${runTag}_` : VERIFY_NAME_PREFIX;
  const emailPrefix = runTag ? `${VERIFY_EMAIL_PREFIX}${runTag}-` : VERIFY_EMAIL_PREFIX;
  const cutoffIso = olderThanMsForStale != null ? new Date(Date.now() - olderThanMsForStale).toISOString() : null;

  function isTargetRow(r) {
    const name = String(r.name || '');
    const email = String(r.email || '');
    const nameMatch = name.startsWith(namePrefix);
    const emailMatch = email.startsWith(emailPrefix) && email.endsWith(`@${VERIFY_EMAIL_DOMAIN}`);
    if (!nameMatch && !emailMatch) return false;
    if (cutoffIso && !(r.created_at && r.created_at < cutoffIso)) return false;
    return true;
  }

  // stores: 店舗名 or メールアドレスのどちらかがタグに（粗く）一致するものをDB側で絞り込み、
  // 実際に削除するかどうかはJS側のisTargetRowで厳密に再確認する。
  const [byName, byEmail] = await Promise.all([
    supabase.from('stores').select('id, name, email, created_at').like('name', `${VERIFY_NAME_PREFIX}%`),
    supabase.from('stores').select('id, name, email, created_at').like('email', `${VERIFY_EMAIL_PREFIX}%@${VERIFY_EMAIL_DOMAIN}`),
  ]);
  if (byName.error) throw new Error(`stores(name)の検索に失敗しました: ${byName.error.message}`);
  if (byEmail.error) throw new Error(`stores(email)の検索に失敗しました: ${byEmail.error.message}`);

  const storeIds = new Set();
  for (const r of [...(byName.data || []), ...(byEmail.data || [])]) {
    if (isTargetRow(r)) storeIds.add(r.id);
  }
  if (storeIds.size > 0) {
    const { error } = await supabase.from('stores').delete().in('id', Array.from(storeIds));
    if (error) throw new Error(`storesの削除に失敗しました: ${error.message}`);
    result.stores = storeIds.size;
  }

  // pending_signups: メールアドレスがタグに一致するもの（照合成功時はRPCが既に削除しているが、
  // 失敗して残ったままの行や、まだ照合していない行を拾う）
  const { data: pendingRows, error: pendingSelErr } = await supabase
    .from('pending_signups')
    .select('id, email, created_at')
    .like('email', `${VERIFY_EMAIL_PREFIX}%@${VERIFY_EMAIL_DOMAIN}`);
  if (pendingSelErr) throw new Error(`pending_signups の検索に失敗しました: ${pendingSelErr.message}`);

  const pendingIds = (pendingRows || [])
    .filter((r) => {
      const email = String(r.email || '');
      if (!(email.startsWith(emailPrefix) && email.endsWith(`@${VERIFY_EMAIL_DOMAIN}`))) return false;
      if (cutoffIso && !(r.created_at && r.created_at < cutoffIso)) return false;
      return true;
    })
    .map((r) => r.id);
  if (pendingIds.length > 0) {
    const { error } = await supabase.from('pending_signups').delete().in('id', pendingIds);
    if (error) throw new Error(`pending_signups の削除に失敗しました: ${error.message}`);
    result.pendingSignups = pendingIds.length;
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

    // 【高-2是正】tagger.name() はmakeRunTag()により英字のみのrunTagを使うため、
    // 店舗名に数字4桁以上が含まれず、findPersonalInfoIssue（server.js）に誤って
    // 引っかからない。これにより正規リクエストが本来のリミッタ判定まで到達できる。
    const legitEmail = tagger.email('v3');
    const legitName = tagger.name('v3');
    const legitRes = await fetch(`${baseUrl}/api/signup/request-code`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: legitName, email: legitEmail }),
    });
    const legitBody = await legitRes.text();

    // 【高-2是正】判定を「429でないこと」から「期待する200であること」に強化する。
    // 以前は400（バリデーションエラー等）も“429ではない”という理由で合格に含めてしまい、
    // AC-V3が中-B是正の有無に関係なく必ず合格する偽陽性を生んでいた（監査人が実測で確認）。
    // 400が返った場合は「検証が成立していない（検証不能）」として明確に不合格にする。
    if (legitRes.status === 400) {
      return {
        id,
        label,
        pass: false,
        summary:
          '正規リクエストがHTTP 400（バリデーションエラー）を返しました。グローバル枠(429)の検証が成立していません（検証不能）',
        detail: `不正リクエストのステータス内訳: ${JSON.stringify(invalidTally)}\n正規リクエストの本文: ${legitBody}`,
      };
    }
    if (legitRes.status !== 200) {
      return {
        id,
        label,
        pass: false,
        summary: `正規リクエストが期待した200ではなくHTTP ${legitRes.status}を返しました。検証は成立していません`,
        detail: `不正リクエストのステータス内訳: ${JSON.stringify(invalidTally)}\n正規リクエストの本文: ${legitBody}`,
      };
    }
    const unexpectedInvalidStatuses = Object.keys(invalidTally).filter((s) => s !== '400');
    if (unexpectedInvalidStatuses.length > 0) {
      // 429が混ざっていれば、それ自体がグローバル枠（または他の枠）が消費された証拠。
      return {
        id,
        label,
        pass: false,
        summary: `不正リクエストが期待した400以外のステータスを返しました: ${JSON.stringify(invalidTally)}`,
        detail: `正規リクエストはHTTP ${legitRes.status}で受理されました`,
      };
    }

    return {
      id,
      label,
      pass: true,
      summary: '',
      detail: `不正リクエスト${AC_V3_INVALID_REQUEST_COUNT}回のステータス内訳: ${JSON.stringify(
        invalidTally
      )}\nその後の正規リクエストはHTTP 200で正常に受理されました`,
    };
  } finally {
    await stopServer(server);
  }
}

// 【中-4是正】プローブ結果を「拒否（合格）」「成功してしまった（不合格）」
// 「404＝対象が存在せず判定不能（検証不能）」の3値に分類する。
function classifyProbeResult(name, status, bodyText, { failures, inconclusive, details }) {
  if (status === 404) {
    inconclusive.push(name);
    details.push(
      `${name}: HTTP 404（対象が存在せず判定不能。supabase/setup.sqlの適用を確認してください） 本文: ${bodyText.slice(0, 300)}`
    );
    return;
  }
  const rejected = status < 200 || status >= 300;
  if (!rejected) failures.push(name);
  details.push(`${name}: HTTP ${status}${rejected ? '（拒否・合格）' : '（成功してしまった・不合格！要即対応）'} 本文: ${bodyText.slice(0, 300)}`);
}

// 【是正：AC-V4がHTTP 401で検証不能になる不具合の修正】
// Supabaseの新形式APIキー（`sb_publishable_...` / `sb_secret_...`）はJWTではない。
// 公式ドキュメントにより、新形式キーを `Authorization: Bearer` に入れて送ると、
// Supabase側がそれをJWTとして解釈しようとして失敗し、HTTP 401を返すことが明記されている
// （"A common mistake is sending a publishable or secret key as a bearer token... This
// will cause 401 errors." / "The new API keys are not JWTs. Instead, put API keys in
// the apikey header."）。新形式キーは `apikey` ヘッダにのみ入れる必要がある。
// 一方、旧形式のanonキー（`eyJ...` のJWT）は、role解決のために従来どおり
// `apikey` と `Authorization: Bearer` の両方に入れる必要がある（PostgRESTの仕様）。
// AC-V4内の全fetch（疎通確認・RPC・GET・INSERT・UPDATE）でヘッダ生成を統一するため、
// この1関数にまとめ、キーの接頭辞（`sb_`かどうか）で自動判定する。
function buildAnonAuthHeaders(anonKey, extraHeaders = {}) {
  const isNewFormatKey = typeof anonKey === 'string' && anonKey.startsWith('sb_');
  const baseHeaders = isNewFormatKey
    ? { apikey: anonKey }
    : { apikey: anonKey, Authorization: `Bearer ${anonKey}` };
  return { ...baseHeaders, ...extraHeaders };
}

// --- AC-V4: anonキーからアクセスできない ---
async function runAcV4({ supabaseUrl, anonKey }) {
  const id = 'AC-V4';
  const label = 'anon からアクセスできない';
  const details = [];
  const failures = [];
  const inconclusive = [];

  const authHeaders = buildAnonAuthHeaders(anonKey, { 'Content-Type': 'application/json' });

  // 【中-4是正・前提確認】anonキーそのものが有効か、意図的に許可されているエンドポイント
  // （PostgRESTのルート）で疎通確認する。無効な鍵（貼り間違い・別プロジェクトの鍵など）だと
  // 以降の全プローブが401を返すため、「何も検証していないのに全部合格」という偽陽性が
  // 起こりうる（監査で指摘済み）。ここで弾ければ「不合格」ではなく「検証不能」として返す。
  const readinessRes = await fetch(`${supabaseUrl}/rest/v1/`, {
    headers: buildAnonAuthHeaders(anonKey),
  });
  if (readinessRes.status !== 200) {
    // 【是正：AC-S9】失敗理由が分かるよう、ステータスコードとレスポンス本文を表示する。
    // 鍵の値そのものは決して出力しない（本文にヘッダの値が含まれることは無いが、
    // 念のため鍵の変数はここでは一切文字列結合に使わない）。
    let readinessBody = '';
    try {
      readinessBody = (await readinessRes.text()).slice(0, 500);
    } catch {
      readinessBody = '(レスポンス本文の取得に失敗しました)';
    }
    return {
      id,
      label,
      pass: false,
      envError: true,
      summary: `anonキーがPostgRESTに受け付けられませんでした（HTTP ${readinessRes.status}）。SUPABASE_ANON_KEYが正しいか確認してください（検証不能）`,
      detail: `疎通確認レスポンス本文（鍵の値は含みません）: ${readinessBody || '(空)'}`,
    };
  }

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
    classifyProbeResult(`RPC ${probe.name}`, res.status, text, { failures, inconclusive, details });
  }

  // 2. 全9テーブルの GET が拒否されること
  for (const table of ALL_TABLES) {
    const res = await fetch(`${supabaseUrl}/rest/v1/${table}?select=*`, {
      headers: buildAnonAuthHeaders(anonKey),
    });
    const text = await res.text();
    classifyProbeResult(`GET ${table}`, res.status, text, { failures, inconclusive, details });
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
  classifyProbeResult('INSERT stores', insertRes.status, insertText, { failures, inconclusive, details });

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
  classifyProbeResult('UPDATE stores', updateRes.status, updateText, { failures, inconclusive, details });

  if (inconclusive.length > 0) {
    return {
      id,
      label,
      pass: false,
      envError: true,
      summary: `検証不能: 一部のプローブが404を返しました（対象が存在しない）: ${inconclusive.join(
        ', '
      )}。supabase/setup.sqlが適用されているか確認してください`,
      detail: details.join('\n    '),
    };
  }

  return {
    id,
    label,
    pass: failures.length === 0,
    summary: failures.length === 0 ? '' : `以下が拒否されず通ってしまいました: ${failures.join(', ')}`,
    detail: details.join('\n    '),
  };
}

// 【中-6是正】「不合格」（実装の欠陥の疑い）・「検証不能」（環境エラー。実装とは無関係）・
// 「未実行」（前段の失敗により実施できなかった）を区別して表示する。
function printSummary(results) {
  console.log('\n============ 検証結果 ============');
  for (const r of results) {
    let verdict;
    if (r.notRun) verdict = '[未実行]';
    else if (r.envError) verdict = '[検証不能(環境エラー)]';
    else verdict = r.pass ? '[合格]' : '[不合格]';
    const line = r.summary ? `${r.id}  ${r.label}  ${verdict} ${r.summary}` : `${r.id}  ${r.label}  ${verdict}`;
    console.log(line);
    if (r.detail) console.log(`    ${r.detail}`);
  }
  const trueFailCount = results.filter((r) => !r.pass && !r.envError && !r.notRun).length;
  const envErrorCount = results.filter((r) => r.envError && !r.notRun).length;
  const notRunCount = results.filter((r) => r.notRun).length;
  const passCount = results.filter((r) => r.pass).length;
  console.log('==================================');
  console.log(
    `合格 ${passCount}件 / 不合格 ${trueFailCount}件 / 検証不能(環境エラー) ${envErrorCount}件 / 未実行 ${notRunCount}件`
  );
  if (trueFailCount > 0) {
    console.log('不合格の項目があります。実装に問題がある可能性があるため、詳細ログを確認してください。');
  }
  if (envErrorCount > 0 || notRunCount > 0) {
    console.log(
      '検証不能・未実行の項目は「実装の欠陥」ではなく「環境（設定・接続）の問題」の可能性があります。原因を解消してから再実行してください。'
    );
  }
  if (trueFailCount === 0 && envErrorCount === 0 && notRunCount === 0) {
    console.log('全項目 合格しました。');
  }
}

async function main() {
  // --- 安全装置1: .env.staging が存在すること（.env は絶対に読まない＝この関数内でも
  // .env というファイル名は一度も参照しない） ---
  if (!fs.existsSync(ENV_STAGING_PATH)) {
    printEnvTemplateGuide();
    return; // 何もせず正常終了(exit code 0)
  }

  // --- 【高-3是正】.env.staging を「唯一の設定源」にする ---
  // dotenv.config()の既定動作は「process.envに既に値がある変数は上書きしない」。これは
  // 逆向きにも危険で、シェルに残った値（例: 過去に本番の疎通確認で $env:SUPABASE_URL に
  // 本番URLを入れたセッション）が .env.staging の値より優先されてしまう（実測で確認済み。
  // 「dotenvの既定動作により安全」という報告は方向が逆だった）。そこで .env.staging を
  // ファイルとして直接parseし、(1)シェル側の値と食い違えば中断、(2)食い違いが無ければ
  // process.envを明示的に上書き、という手順に変更する。
  let parsedStaging;
  try {
    parsedStaging = dotenv.parse(fs.readFileSync(ENV_STAGING_PATH));
  } catch (e) {
    console.error(`[中断] .env.staging の読み込みに失敗しました: ${e.message}`);
    process.exitCode = 1;
    return;
  }

  const conflictingKeys = ENV_CONFLICT_CHECK_KEYS.filter(
    (k) => process.env[k] !== undefined && process.env[k] !== parsedStaging[k]
  );
  if (conflictingKeys.length > 0) {
    // 値そのもの（鍵を含みうる）は絶対に表示せず、変数名だけを出す。
    console.error(
      `[中断] 次の環境変数がシェル側に既に設定されており、.env.staging の内容と食い違っています: ${conflictingKeys.join(
        ', '
      )}`
    );
    console.error('シェルに古い値（本番の設定である可能性があります）が残っている恐れがあります。');
    console.error('新しいターミナルを開いてから、もう一度実行してください。');
    process.exitCode = 1;
    return;
  }
  // .env.staging の値を最終的な権威にする（既存のprocess.env値も明示的に上書きする）。
  Object.assign(process.env, parsedStaging);

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

  // --- 【中-5是正】server.js は require された瞬間に require('dotenv').config() を実行し、
  // process.cwd()/.env（本番の設定ファイル）を読み込む。「.envは読まない」という以前の
  // 説明は事実と異なっていた（監査人の指摘）。.env.staging に無い変数（STRIPE_SECRET_KEY等）
  // が本番の値で埋まってしまう恐れがあるため、require('../server')する前にcwdの.envの
  // 存在を検出し、あれば中断する。 ---
  const cwdEnvPath = path.join(process.cwd(), '.env');
  if (fs.existsSync(cwdEnvPath)) {
    console.error(`[中断] ${cwdEnvPath} が存在します。server.js はこのファイルを自動で読み込みます。`);
    console.error('検証中に本番の設定（STRIPE_SECRET_KEY等）が紛れ込むのを防ぐため、');
    console.error('検証の間だけ .env を別名（例: .env.bak）にリネームしてから、もう一度実行してください。');
    process.exitCode = 1;
    return;
  }

  const supabaseUrl = process.env.SUPABASE_URL.trim();

  // supabase-js は server.js を経由せずに直接requireする（安全装置0のapp_config確認に
  // 必要なため、server.js本体のrequireより前に行う）。
  let createClient;
  try {
    ({ createClient } = require('@supabase/supabase-js'));
  } catch (err) {
    console.error('[中断] @supabase/supabase-js の読み込みに失敗しました。');
    console.error(String((err && err.stack) || err));
    process.exitCode = 1;
    return;
  }
  const supabase = createClient(supabaseUrl, process.env.SUPABASE_SERVICE_KEY);

  // --- 【高-1是正・安全装置0（最優先）】接続先DBに「検証用DBである」目印が無ければ中断する ---
  // 従来の安全装置（.env.stagingの存在・STAGING_CONFIRMED・PRODUCTION_SUPABASE_URLとの
  // 不一致・stores件数の閾値）は、いずれも「.envを.env.stagingにコピーする」「シェルに
  // STAGING_CONFIRMED=yesを1行足す」といった誤操作、あるいは閾値そのもの
  // （サービス開始直後の本番はstoresが0〜数件で閾値10件に届かない）で本番に対しても
  // 素通りしてしまうことが監査で指摘された。DB側の目印（app_config.environment='staging'）を
  // 必須にすることで、本番DBにこの行が存在しない限り、他のどの安全装置を満たしても
  // 実行できないようにする。この確認は他のどの安全装置よりも先に行い、--yesがあっても
  // 絶対にスキップしない。
  const { data: envMarkerRow, error: envMarkerErr } = await supabase
    .from('app_config')
    .select('value')
    .eq('key', APP_CONFIG_STAGING_KEY)
    .maybeSingle();
  if (envMarkerErr || !envMarkerRow || envMarkerRow.value !== APP_CONFIG_STAGING_VALUE) {
    console.error('[中断] 接続先データベースに、検証用DBであることを示す目印がありません。');
    console.error('本番データベースにこの行を入れてはいけません。この確認だけは --yes を付けても省略できません。');
    console.error('');
    console.error('検証用Supabaseプロジェクトの SQL Editor で、次のSQL文を1回だけ実行してから、もう一度このスクリプトを実行してください:');
    console.error('');
    console.error(`  ${APP_CONFIG_STAGING_INSERT_SQL}`);
    console.error('');
    if (envMarkerErr) {
      console.error(`（参考: app_config の確認時にエラーが発生しました: ${envMarkerErr.message}）`);
      console.error('supabase/setup.sql が適用されているか（app_config テーブルの有無）も確認してください。');
    }
    process.exitCode = 1;
    return;
  }

  // --- 安全装置2: STAGING_CONFIRMED=yes ---
  if (process.env.STAGING_CONFIRMED !== 'yes') {
    console.error('[中断] STAGING_CONFIRMED=yes が設定されていません。安全のため何もせず終了します。');
    process.exitCode = 1;
    return;
  }

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

  // ここまでで環境変数・DB接続先の安全確認が完了。server.js を require する
  // （cwdに.envが無いことは既に確認済みなので、中-5の問題は起きない）。
  let buildApp;
  let createRateLimiter;
  try {
    ({ buildApp } = require('../server'));
    ({ createRateLimiter } = require('../lib/rateLimit'));
  } catch (err) {
    console.error('[中断] server.js の読み込みに失敗しました。buildApp が export されているか確認してください。');
    console.error(String((err && err.stack) || err));
    process.exitCode = 1;
    return;
  }

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
  console.log(`（鍵はこの画面に表示しません。現在の stores 件数: ${storeCount}件。検証用DBの目印を確認済みです）`);

  const skipPrompt = process.argv.slice(2).includes('--yes');
  if (skipPrompt) {
    console.log('（--yes が指定されたため、確認プロンプトを省略します。ただし検証用DBの目印確認は既に必須で通過済みです）');
  } else {
    const answer = await askYesNo('この接続先に対して検証を実行します。よろしいですか？ ("yes" と入力してEnter): ');
    if (answer.trim() !== 'yes') {
      console.error('[中断] 確認が得られなかったため終了します（何も実行していません）。');
      process.exitCode = 1;
      return;
    }
  }

  const runTag = makeRunTag();
  const tagger = makeTagger(runTag);
  const results = [];
  let preCleanupError = null;

  // 起動時クリーンアップ（冪等性）：前回の実行が途中で落ちていた場合の残骸を先に消す。
  // 【中-3是正】runTagでは絞れない（前回の実行のrunTagは分からない）ため、代わりに
  // 「十分に古い（PRE_CLEANUP_STALE_MS以上前）」データだけを対象にし、同時に走っている
  // 別プロセスの実行中データには触れない。
  try {
    const preCleanup = await cleanupTaggedData(supabase, { olderThanMsForStale: PRE_CLEANUP_STALE_MS });
    console.log(
      `起動時クリーンアップ: ${Math.round(PRE_CLEANUP_STALE_MS / 3600000)}時間以上前の残骸データを stores=${preCleanup.stores}件, pending_signups=${preCleanup.pendingSignups}件 削除しました`
    );
  } catch (err) {
    // 【中-2是正】エラーを握りつぶさない。以降のAC実行はすべて「未実行」として報告する。
    preCleanupError = err;
    console.error('[警告] 起動時クリーンアップに失敗しました。検証は実施しません:', err.message);
  }

  const AC_DEFS = [
    { id: 'AC-V1', label: '正しいコードで登録が完走', run: () => runAcV1({ supabase, buildApp, tagger }) },
    { id: 'AC-V2', label: '同時5本でも店舗は1件だけ', run: () => runAcV2({ supabase, buildApp, tagger }) },
    { id: 'AC-V3', label: '不正リクエストが枠を消費しない', run: () => runAcV3({ supabase, buildApp, createRateLimiter, tagger }) },
    { id: 'AC-V4', label: 'anon からアクセスできない', run: () => runAcV4({ supabaseUrl, anonKey: process.env.SUPABASE_ANON_KEY }) },
  ];

  if (preCleanupError) {
    // 【中-6是正】前段の失敗で実施できなかった項目を「不合格」ではなく「未実行」として
    // 一覧に出す（実装の欠陥と誤読されないようにするため）。
    for (const { id, label } of AC_DEFS) {
      results.push({
        id,
        label,
        pass: false,
        notRun: true,
        summary: '起動時クリーンアップに失敗したため、この項目は実行していません',
        detail: String((preCleanupError && preCleanupError.stack) || preCleanupError),
      });
    }
  } else {
    // 【中-6是正】各ACを個別にtry/catchする。以前は4項目まとめて1つのtry/catchだったため、
    // 環境起因のエラー（DB未セットアップ・鍵の貼り間違い等）が1件でも起きると、残りの
    // ACは一覧に一切現れず「不合格1件」とだけ表示され、実装の欠陥と誤読される恐れがあった。
    for (const { id, label, run } of AC_DEFS) {
      try {
        results.push(await run());
      } catch (err) {
        results.push({
          id,
          label,
          pass: false,
          envError: true,
          summary: `検証を実施できませんでした（実装の不合格ではなく環境エラーの可能性があります）: ${err.message}`,
          detail: String((err && err.stack) || err),
        });
      }
    }
  }

  // 後片付け（try/finally相当・必ず実行する）。今回のrunTagで作られたデータだけを対象にする
  // 【中-3是正】ことで、同時に走っている別プロセスのデータを巻き込まないようにする。
  try {
    const postCleanup = await cleanupTaggedData(supabase, { runTag });
    console.log(
      `後片付け: 今回の実行(runTag=${runTag})が作ったデータを stores=${postCleanup.stores}件, pending_signups=${postCleanup.pendingSignups}件 削除しました`
    );
  } catch (cleanupErr) {
    // 【中-2是正】失敗を握りつぶさず、正直に警告し、手動確認の手がかりを出す。終了コードにも反映する。
    console.error('[警告] 後片付けに失敗しました。手動で確認してください:', cleanupErr.message);
    console.error(
      `手がかり: stores.name が "${VERIFY_NAME_PREFIX}${runTag}_" で始まる行 / pending_signups.email が "${VERIFY_EMAIL_PREFIX}${runTag}-...@${VERIFY_EMAIL_DOMAIN}" の行`
    );
    process.exitCode = 1;
  }

  printSummary(results);
  const hasProblem = results.some((r) => !r.pass || r.envError || r.notRun);
  if (process.exitCode !== 1) {
    process.exitCode = hasProblem ? 1 : 0;
  }
}

main().catch((err) => {
  console.error('[中断] スクリプトの実行中に致命的なエラーが発生しました:', err);
  process.exitCode = 1;
});
