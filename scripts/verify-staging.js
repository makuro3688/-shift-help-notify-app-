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
 * 実際にRPCを実行し、次の7点を確認する。
 *
 *   AC-V1: 正しい確認コードで店舗登録が完走する（500にならない＝中-1是正の確認）
 *   AC-V2: 正しいコードを同時5本投げても、作成される店舗は1件だけ（中-A是正の確認）
 *   AC-V3: 不正なボディを300回投げても、その後の正規リクエストが429にならない（中-B是正の確認）
 *   AC-V4: anonキーからRPC・全テーブルの読み書きができない（権限設定の確認）
 *   AC-V5: 確認コードは5回間違えると失効する（SECURITY_REVIEW_L5_FINAL2.md 第8部 #5 の確認）
 *   AC-V6: 確認コード再送の60秒クールダウンが効く（同 #6 の確認）
 *   AC-V7: 同一メールアドレスは1時間に5通まで（同 #8 の確認）
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
 * ============================================================================
 * 【是正履歴2（AC-V4「検証不能」の解消・2026-08-09）】
 * AC-V1〜AC-V3合格後、AC-V4のみ「検証不能（環境エラー）」が残っていた。
 * 実機で疎通確認用の `GET /rest/v1/` が新形式publishable/anonキーに対して
 * HTTP 401 `{"message":"Secret API key required", ...}` を返すことが判明した
 * （鍵もDAIDA+実装も正しく、疎通確認の方法が不適切だった）。
 *
 *   AC-S12: 疎通確認のエンドポイントが実は secret キー専用だった
 *           → `GET /rest/v1/` をやめ、`GET /auth/v1/settings` に変更した。
 *             publishable/anonキーが有効なら200、無効なら401を返す公開エンドポイント。
 *   AC-S13/AC-S14: 404を一律「判定不能」としていたため、setup.sqlのREVOKEにより
 *           PostgRESTのスキーマキャッシュから外れたRPC/テーブル（＝正しく拒否されている
 *           証拠）まで「検証不能」に倒れ、AC-V4が恒久的に合格しない状態だった
 *           → secretキー（service_role）で `GET /rest/v1/` のOpenAPIスキーマを取得し、
 *             対象RPC/テーブルの存在を先に確認する（fetchSecretSchemaPaths）。存在確認
 *             できたものに限り、anonの401/403/404を「拒否＝合格」、2xxを「不合格」、
 *             それ以外（500等）は安全側に倒して「判定不能」とする（classifyProbeResult）。
 *             secretキーでも存在確認できない場合のみ「検証不能」とする。
 * ============================================================================
 *
 * ============================================================================
 * 【追加3（AC-V5〜AC-V7の追加・2026-08-09）】
 * AC-V1〜AC-V4合格後、SECURITY_REVIEW_L5_FINAL2.md 第8部（本番反映前チェックリスト）のうち
 * まだ実機確認できていなかった #5・#6・#8 を追加する。既存のAC-V1〜V4・安全装置・後片付けは
 * 一切変更していない（新規関数の追加とAC_DEFSへの追記のみ）。
 *
 *   AC-V5: 確認コードを5回間違えた後、正しいコードでも失敗する（失効の確認）。
 *          consume_signup_attempt RPC（supabase/setup.sql）は attempts < p_max の行しか
 *          UPDATEにヒットさせないため、5回消費した後は6回目が正しいコードでも
 *          UPDATE自体が0行になり、ハッシュ照合にすら到達しない（ユニットテストでは
 *          確認済みだが実DB未確認だった）。
 *   AC-V6: request-codeの60秒クールダウン。時間を実際に待つ代わりに、pending_signupsの
 *          created_atをservice_roleで61秒前に書き換えることで、経過時間の演出だけを
 *          短時間で再現する（意図は各所のコメントに明記）。
 *   AC-V7: 同一メールアドレスは1時間5通まで。AC-V6と同じcreated_at書き換え手法で
 *          60秒クールダウンを回避しながら6回連続でrequest-codeを呼び、6回目だけが
 *          429になることを確認する。
 *
 * 【呼び出し回数の管理】verify-codeにはIP単位の制限（10分20回・overridesで上書き不可）が
 * あり、AC-V1(1回)+AC-V2(5回)+AC-V5(6回)=12回で上限20回に収まる。AC-V6・AC-V7は
 * request-code（別エンドポイント・別のIP制限）を使うため、この20回には影響しない。
 * ただしAC-V6・AC-V7はメール単位・グローバル単位の「本物の」レート制限枠を実際に消費する
 * ため、不正リクエストが枠を消費しないことを検証するAC-V3より後に実行する（AC_DEFSの順序で
 * 担保）。request-code側のIP単位制限（1時間10回）はAC-V6・AC-V7の検証対象ではないため、
 * AC-V3と同じ手法でIP単位のリミッタだけを実質無制限に差し替え、メール単位・グローバル単位は
 * 本物のリミッタのまま検証する。
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
// 【AC-V6/AC-V7でも使い回す】request-codeのIP単位リミッタを緩めるための上限値・窓は
// AC-V3のものと全く同じ性質（「検証対象ではない別の制限に触れないようにする」ため）なので、
// 定数も共有する。

// AC-V5: わざと間違ったコードを何回投げるか（L-5対策「5回で失効」に合わせる。
// server.js の SIGNUP_CODE_MAX_ATTEMPTS と同じ値）。
const AC_V5_WRONG_ATTEMPTS = 5;

// AC-V6: request_signup_code RPC（supabase/setup.sql）の再送クールダウン秒数。
// server.js の SIGNUP_CODE_RESEND_COOLDOWN_SECONDS と同じ値。
const AC_V6_COOLDOWN_SECONDS = 60;
// 【時間を待たずにクールダウンを検証する手法】created_atを何秒前に書き換えるか。
// RPCの判定式 `p.created_at <= now() - (p_cooldown_seconds || ' seconds')::interval`
// （supabase/setup.sql:276）はちょうど60秒だと境界値（<=なので理論上は60秒ちょうどで
// 通過するはずだが、書き換え・比較の間の実行時間ゆらぎで境界を跨いでしまう可能性を
// 排除するため）、確実に条件を満たすよう60秒より1秒多い61秒前にする。
const AC_V6_REWIND_SECONDS = AC_V6_COOLDOWN_SECONDS + 1;

// AC-V7: 同一メールアドレスへの1時間あたりの上限（server.js の
// REQUEST_CODE_EMAIL_RATE_LIMIT_MAX_REQUESTS と同じ値）。上限+1回目（6回目）が
// 429になることを確認するため、合計で6回投げる。
const AC_V7_EMAIL_LIMIT = 5;
const AC_V7_TOTAL_REQUESTS = AC_V7_EMAIL_LIMIT + 1;

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

// AC-V5用：正しいコードとは異なる6桁コードを生成する（わざと間違えるため）。
// 衝突確率は900000分の1と極めて低いが、念のためcorrectCodeと一致したら引き直す。
function generateWrongCode(correctCode) {
  let candidate;
  do {
    candidate = generateCode();
  } while (candidate === correctCode);
  return candidate;
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

// 【AC-V6/AC-V7用】pending_signups.created_at を service_role で過去の時刻に書き換える。
// 【重要・時間を待たずにクールダウンを検証する手法】request_signup_code RPC の60秒
// クールダウンは pending_signups.created_at を起点に判定される（supabase/setup.sql:276）。
// 実際に60秒待つのはユーザーの手動実行のたびに時間がかかり非現実的なため、
// 「created_atを直接過去に書き換える」ことで、経過時間の演出だけを短時間で再現する。
// これはアプリのAPIを経由しない、検証専用のservice_role直接操作であり、本番相当の
// 挙動（時間経過でクールダウンが解ける）をそのまま踏襲して確認するためのショートカットに
// すぎない（クールダウンの判定ロジック自体はRPC内の本物のSQLがそのまま実行される）。
async function rewritePendingSignupCreatedAtToPast(supabase, { email, secondsAgo }) {
  const pastIso = new Date(Date.now() - secondsAgo * 1000).toISOString();
  const { data, error } = await supabase
    .from('pending_signups')
    .update({ created_at: pastIso })
    .eq('email', email)
    .select('id, created_at');
  if (error) {
    throw new Error(`pending_signups.created_at の書き換えに失敗しました（email=${email}）: ${error.message}`);
  }
  if (!data || data.length === 0) {
    throw new Error(`pending_signups.created_at の書き換え対象行が見つかりませんでした（email=${email}）`);
  }
  return data[0];
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

// 【是正：中-4是正の再修正（AC-S13/AC-S14対応）】
// 旧実装は「404＝判定不能」と一律に扱っていたが、これは誤りだった。
// supabase/setup.sqlは対象のRPC・テーブルに対して
// `revoke all on ... from public, anon, authenticated` を実行しており、
// PostgRESTはそのロールが実行/参照できないオブジェクトをスキーマキャッシュに載せない
// ため、権限が無いだけの場合でも404が返る（「存在しない」のではなく「anonからは見えない」）。
// そのため404を一律「判定不能」にすると、setup.sqlが正しく適用されているケースほど
// AC-V4が「検証不能」のまま合格しなくなってしまう。
// 対策として、呼び出し側で事前にsecretキー（service_role）を使い、対象のRPC/テーブルが
// 実際に存在するかどうかを確認させ（confirmedExists）、その結果をこの関数に渡す。
//   - confirmedExists === false （secretキーでも存在確認できない）
//       → 「判定不能」。本当に未セットアップの可能性が高いため合否を出さない。
//   - confirmedExists === true かつ anonが 401/403/404 のいずれか
//       → 「拒否＝合格」。存在はするが権限が無いため弾かれた、という一番安全な状態。
//   - confirmedExists === true かつ anonが 2xx
//       → 「成功してしまった＝不合格」。権限が無いはずのanonから操作できてしまっている。
//   - confirmedExists === true かつ それ以外（500等の想定外ステータス）
//       → 拒否とも成功とも断定できないため、安全側に倒して「判定不能」。
function classifyProbeResult(name, confirmedExists, status, bodyText, { failures, inconclusive, details }) {
  const bodyPreview = bodyText.slice(0, 300);

  if (!confirmedExists) {
    inconclusive.push(name);
    details.push(
      `${name}: secretキーでも対象の存在を確認できませんでした（判定不能。supabase/setup.sqlが適用されているか確認してください） anonの応答: HTTP ${status} 本文: ${bodyPreview}`
    );
    return;
  }

  if (status >= 200 && status < 300) {
    failures.push(name);
    details.push(`${name}: HTTP ${status}（成功してしまった・不合格！要即対応） 本文: ${bodyPreview}`);
    return;
  }

  if (status === 401 || status === 403 || status === 404) {
    details.push(`${name}: HTTP ${status}（対象の存在はsecretキーで確認済み。拒否・合格） 本文: ${bodyPreview}`);
    return;
  }

  // 401/403/404以外（500等）は「拒否された」という確証が無いため、合格にはせず判定不能とする。
  inconclusive.push(name);
  details.push(`${name}: 想定外のHTTPステータス ${status}（拒否とも成功とも判定できないため判定不能） 本文: ${bodyPreview}`);
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
// 【是正：AC-S13対応で関数名を汎用化】この判定ロジックはanonキーだけでなく、
// secretキー（service_role）でも全く同じ（新形式なら`apikey`のみ、旧JWT形式なら
// `apikey`+`Authorization: Bearer`両方）なので、AC-V4内の「secretキーで存在確認する」
// 処理にもそのまま使い回せるよう、関数名をbuildAnonAuthHeadersからbuildApiKeyHeadersに変更した。
function buildApiKeyHeaders(apiKey, extraHeaders = {}) {
  const isNewFormatKey = typeof apiKey === 'string' && apiKey.startsWith('sb_');
  const baseHeaders = isNewFormatKey
    ? { apikey: apiKey }
    : { apikey: apiKey, Authorization: `Bearer ${apiKey}` };
  return { ...baseHeaders, ...extraHeaders };
}

// 【是正：AC-S13】secretキー（service_role）でPostgRESTのOpenAPIスキーマ
// （GET /rest/v1/）を取得し、対象のRPC・テーブルが実際に存在するかどうかを確認する。
// このエンドポイントはAC-V4の疎通確認で以前使っていた `GET /rest/v1/` そのものだが、
// 実機で "Only secret API keys can be used for this endpoint." というHTTP 401が
// 確認されたとおり、secretキー専用のエンドポイントである。逆に言えば、secretキーで
// 叩けば必ずservice_roleから見えるフルスキーマ（GRANT/REVOKEの影響を受けない）が
// 返るため、「対象が本当に存在するか」を安全に（実際にRPCを実行せず副作用ゼロで）
// 確認する手段として使える。PostgRESTのOpenAPI(Swagger)仕様は、`paths`オブジェクトの
// キーとしてテーブルは `/テーブル名`、RPCは `/rpc/関数名` を持つ。
async function fetchSecretSchemaPaths(supabaseUrl, secretKey) {
  const res = await fetch(`${supabaseUrl}/rest/v1/`, {
    headers: buildApiKeyHeaders(secretKey),
  });
  const bodyText = await res.text();
  if (res.status !== 200) {
    return { ok: false, status: res.status, bodyText: bodyText.slice(0, 500) };
  }
  const json = safeJsonParse(bodyText);
  if (!json || typeof json.paths !== 'object' || json.paths === null) {
    return {
      ok: false,
      status: res.status,
      bodyText: '(OpenAPIスキーマのparseに失敗、または paths フィールドがありません)',
    };
  }
  return { ok: true, paths: new Set(Object.keys(json.paths)) };
}

// --- AC-V4: anonキーからアクセスできない ---
async function runAcV4({ supabaseUrl, anonKey, secretKey }) {
  const id = 'AC-V4';
  const label = 'anon からアクセスできない';
  const details = [];
  const failures = [];
  const inconclusive = [];

  const authHeaders = buildApiKeyHeaders(anonKey, { 'Content-Type': 'application/json' });

  // 【是正：AC-S12】疎通確認のエンドポイントを `GET /rest/v1/`（secretキー専用。実機で
  // "Only secret API keys can be used for this endpoint." というHTTP 401を確認済み）
  // から `GET /auth/v1/settings` に変更する。このエンドポイントはSupabase Authの
  // 公開設定（サインアップ可否等）を返すもので、`apikey` ヘッダに有効な
  // publishable/anonキーを渡せば200、無効な鍵なら401を返す。公式ドキュメントに
  // 明記された「anon/publishableキーが有効かどうか」だけを切り分けるための
  // エンドポイントであり、テーブルやRPCといったDAIDA+のデータには一切触れないため、
  // 疎通確認そのものが誤検知（偽陽性/偽陰性）を生む心配もない。
  const readinessRes = await fetch(`${supabaseUrl}/auth/v1/settings`, {
    headers: buildApiKeyHeaders(anonKey),
  });
  if (readinessRes.status !== 200) {
    // 【AC-S9を踏襲】失敗理由が分かるよう、ステータスコードとレスポンス本文を表示する。
    // 鍵の値そのものは決して出力しない。
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
      summary: `anonキーが/auth/v1/settingsに受け付けられませんでした（HTTP ${readinessRes.status}）。SUPABASE_ANON_KEYが正しいか確認してください（検証不能）`,
      detail: `疎通確認レスポンス本文（鍵の値は含みません）: ${readinessBody || '(空)'}`,
    };
  }

  // 【是正：AC-S13】anonの404を無条件で「判定不能」とせず、secretキーで対象の存在を
  // 先に確認する。secretキーでの疎通・スキーマ取得自体が失敗した場合、以降の全プローブの
  // 存在確認ができないため、AC-V4全体を「検証不能」として打ち切る（SUPABASE_SERVICE_KEYの
  // 誤りやsetup.sql未適用の可能性がある）。
  const secretSchema = await fetchSecretSchemaPaths(supabaseUrl, secretKey);
  if (!secretSchema.ok) {
    return {
      id,
      label,
      pass: false,
      envError: true,
      summary: `secretキー（SUPABASE_SERVICE_KEY）でのスキーマ確認に失敗しました（HTTP ${secretSchema.status}）。RPC/テーブルの存在確認ができないため検証不能です`,
      detail: `スキーマ確認レスポンス本文（鍵の値は含みません）: ${secretSchema.bodyText || '(空)'}`,
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
    const confirmedExists = secretSchema.paths.has(`/rpc/${probe.name}`);
    const res = await fetch(`${supabaseUrl}/rest/v1/rpc/${probe.name}`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify(probe.body),
    });
    const text = await res.text();
    classifyProbeResult(`RPC ${probe.name}`, confirmedExists, res.status, text, { failures, inconclusive, details });
  }

  // 2. 全9テーブルの GET が拒否されること
  const tableExists = {};
  for (const table of ALL_TABLES) {
    const confirmedExists = secretSchema.paths.has(`/${table}`);
    tableExists[table] = confirmedExists;
    const res = await fetch(`${supabaseUrl}/rest/v1/${table}?select=*`, {
      headers: buildApiKeyHeaders(anonKey),
    });
    const text = await res.text();
    classifyProbeResult(`GET ${table}`, confirmedExists, res.status, text, { failures, inconclusive, details });
  }

  // 3. stores への INSERT / UPDATE も拒否されること（admin_key_hash書き換え＝権限奪取の防止確認）
  // storesの存在確認は直前の「2.」のGETループで既にsecretキーのスキーマから確認済みのため
  // （tableExists.stores）、その結果を使い回す（secretキーへの追加リクエストは不要）。
  const storesConfirmedExists = tableExists.stores === true;
  const insertRes = await fetch(`${supabaseUrl}/rest/v1/stores`, {
    method: 'POST',
    headers: { ...authHeaders, Prefer: 'return=representation' },
    body: JSON.stringify({
      name: `${VERIFY_NAME_PREFIX}ac_v4_insert_should_be_rejected`,
      admin_key_hash: `should_never_land_${Date.now()}`,
    }),
  });
  const insertText = await insertRes.text();
  classifyProbeResult('INSERT stores', storesConfirmedExists, insertRes.status, insertText, {
    failures,
    inconclusive,
    details,
  });

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
  classifyProbeResult('UPDATE stores', storesConfirmedExists, updateRes.status, updateText, {
    failures,
    inconclusive,
    details,
  });

  // 【是正：AC-S14】anonで2xxが1件でも返っていれば（failuresに積まれている）、
  // 他がinconclusiveであろうと関係なく必ず不合格として明示する。「拒否されたことを合格」と
  // 判定するロジックを緩めすぎて2xxを見逃すことがないよう、こちらを優先して判定する。
  if (failures.length > 0) {
    return {
      id,
      label,
      pass: false,
      summary: `以下が拒否されず通ってしまいました: ${failures.join(', ')}`,
      detail: details.join('\n    '),
    };
  }

  if (inconclusive.length > 0) {
    return {
      id,
      label,
      pass: false,
      envError: true,
      summary: `検証不能: secretキーでも存在確認できなかった、または想定外のステータスが返ったプローブがあります: ${inconclusive.join(
        ', '
      )}。supabase/setup.sqlが適用されているか確認してください`,
      detail: details.join('\n    '),
    };
  }

  return {
    id,
    label,
    pass: true,
    summary: '',
    detail: details.join('\n    '),
  };
}

// --- AC-V5: 確認コードは5回間違えると失効する（チェックリスト #5） ---
// 手順：(1) 既知のコードでpending_signupsに1行投入 (2) わざと間違ったコードで5回叩く
// （すべて失敗するはず） (3) その後、正しいコードで叩く (4) それでも失敗する（=失効）ことを
// 確認する。途中の5回のどこかで成功してしまったら、それ自体が不合格（=総当たりが通る）。
async function runAcV5({ supabase, buildApp, tagger }) {
  const id = 'AC-V5';
  const label = '確認コードは5回間違えると失効する';
  const email = tagger.email('v5');
  const name = tagger.name('v5');
  const correctCode = generateCode();

  await insertPendingSignup(supabase, { email, name, code: correctCode });

  const app = buildApp({ supabase, sendSignupCodeEmail: dummySendEmail });
  const { server, baseUrl } = await startServer(app);
  try {
    const wrongResults = [];
    for (let i = 0; i < AC_V5_WRONG_ATTEMPTS; i++) {
      const wrongCode = generateWrongCode(correctCode);
      const res = await fetch(`${baseUrl}/api/signup/verify-code`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, code: wrongCode }),
      });
      wrongResults.push({ attempt: i + 1, status: res.status });
    }

    // 【重要】5回のうちどこかで成功(201)してしまったら、その時点で不合格として確定する。
    const succeededEarly = wrongResults.find((r) => r.status === 201);
    if (succeededEarly) {
      return {
        id,
        label,
        pass: false,
        summary: `誤ったコードの${succeededEarly.attempt}回目で登録が成功してしまいました（不合格・途中成功）`,
        detail: `各回のステータス: ${JSON.stringify(wrongResults)}`,
      };
    }
    const unexpectedWrongStatus = wrongResults.find((r) => r.status !== 400);
    if (unexpectedWrongStatus) {
      return {
        id,
        label,
        pass: false,
        summary: `誤ったコードへの応答に期待した400以外が含まれていました（検証が成立していません）: ${JSON.stringify(
          tally(wrongResults.map((r) => r.status))
        )}`,
        detail: `各回のステータス: ${JSON.stringify(wrongResults)}`,
      };
    }

    // 5回間違えた直後、正しいコードでも失敗する（=失効している）はず。
    const finalRes = await fetch(`${baseUrl}/api/signup/verify-code`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, code: correctCode }),
    });
    const finalBody = await finalRes.text();

    if (finalRes.status === 201) {
      return {
        id,
        label,
        pass: false,
        summary: '5回間違えた直後、正しいコードで登録が成功してしまいました（コードが失効していません・不合格）',
        detail: `誤ったコード5回のステータス: ${JSON.stringify(wrongResults)}\n最終(正しいコード)レスポンス: HTTP ${finalRes.status} ${finalBody}`,
      };
    }
    if (finalRes.status !== 400) {
      return {
        id,
        label,
        pass: false,
        summary: `5回失効後、正しいコードへの応答が期待した400ではなくHTTP ${finalRes.status}でした（検証が成立していません）`,
        detail: `誤ったコード5回のステータス: ${JSON.stringify(wrongResults)}\n最終レスポンス本文: ${finalBody}`,
      };
    }

    return {
      id,
      label,
      pass: true,
      summary: '',
      detail: `誤ったコードを${AC_V5_WRONG_ATTEMPTS}回投げて全てHTTP 400（各回: ${JSON.stringify(
        wrongResults
      )}）だった後、正しいコードでもHTTP 400で拒否されました（5回失効を確認）`,
    };
  } finally {
    await stopServer(server);
  }
}

// --- AC-V6: 再送の60秒クールダウンが効く（チェックリスト #6） ---
// 手順：(1) request-codeを1回呼ぶ（成功するはず） (2) すぐにもう一度呼ぶ→429を確認
// (3) pending_signupsのcreated_atをservice_roleで61秒前に書き換える (4) もう一度呼ぶ→
// 今度は成功することを確認する。
async function runAcV6({ supabase, buildApp, createRateLimiter, tagger }) {
  const id = 'AC-V6';
  const label = '再送の60秒クールダウンが効く';
  const email = tagger.email('v6');
  const name = tagger.name('v6');

  // 【検証の意図】AC-V6が確認したいのはrequest-codeの「クールダウン」だけである。
  // 同エンドポイントには別のIP単位レート制限（1時間10通）もかかっており、AC-V6・AC-V7を
  // 通しで実行すると無関係にそちらへ触れてしまう恐れがあるため、AC-V3と同じ手法で
  // IP単位のリミッタだけを実質無制限にする。メール単位・グローバル単位のリミッタは
  // 本物のまま使う（overridesを渡さない＝server.jsの本物のリミッタがそのまま使われる）。
  const looseIpLimiter = createRateLimiter(AC_V3_LOOSE_IP_LIMIT_WINDOW_MS, AC_V3_LOOSE_IP_LIMIT_MAX_REQUESTS);
  const app = buildApp({
    supabase,
    requestCodeIpLimiter: looseIpLimiter,
    sendSignupCodeEmail: dummySendEmail,
  });
  const { server, baseUrl } = await startServer(app);
  try {
    const firstRes = await fetch(`${baseUrl}/api/signup/request-code`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, email }),
    });
    const firstBody = await firstRes.text();
    if (firstRes.status !== 200) {
      return {
        id,
        label,
        pass: false,
        summary: `1回目のrequest-codeが期待した200ではなくHTTP ${firstRes.status}でした（検証不能）`,
        detail: `レスポンス本文: ${firstBody}`,
      };
    }

    // すぐにもう一度呼ぶ → クールダウン中のため429になるはず
    const secondRes = await fetch(`${baseUrl}/api/signup/request-code`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, email }),
    });
    const secondBody = await secondRes.text();
    if (secondRes.status !== 429) {
      return {
        id,
        label,
        pass: false,
        summary: `直後の2回目のrequest-codeが期待した429ではなくHTTP ${secondRes.status}でした（クールダウンが効いていない・不合格）`,
        detail: `1回目: HTTP ${firstRes.status}\n2回目: HTTP ${secondRes.status} ${secondBody}`,
      };
    }

    // 【時間を待たずにクールダウンを検証する手法】created_atを61秒前に書き換える
    // （詳細な意図は rewritePendingSignupCreatedAtToPast のコメントを参照）。
    await rewritePendingSignupCreatedAtToPast(supabase, { email, secondsAgo: AC_V6_REWIND_SECONDS });

    const thirdRes = await fetch(`${baseUrl}/api/signup/request-code`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, email }),
    });
    const thirdBody = await thirdRes.text();
    if (thirdRes.status !== 200) {
      return {
        id,
        label,
        pass: false,
        summary: `created_atを${AC_V6_REWIND_SECONDS}秒前に書き換えた後の3回目が期待した200ではなくHTTP ${thirdRes.status}でした（不合格）`,
        detail: `1回目: HTTP ${firstRes.status}\n2回目(即時): HTTP ${secondRes.status}\n3回目(${AC_V6_REWIND_SECONDS}秒前に書き換え後): HTTP ${thirdRes.status} ${thirdBody}`,
      };
    }

    return {
      id,
      label,
      pass: true,
      summary: '',
      detail: `1回目:HTTP 200 → 直後の2回目:HTTP 429(クールダウン中) → created_atを${AC_V6_REWIND_SECONDS}秒前に書き換え後の3回目:HTTP 200 を確認しました`,
    };
  } finally {
    await stopServer(server);
  }
}

// --- AC-V7: 同一メールアドレスは1時間に5通まで（チェックリスト #8） ---
// 手順：AC-V6と同じ「created_atを過去に書き換える」手法で60秒クールダウンを回避しながら、
// 同じメールアドレスで6回request-codeを呼ぶ。5回目までは成功し、6回目が429になることを確認する。
// 【注意】このACはメール単位・グローバル単位の「本物の」レート制限枠を実際に消費する
// （メール送信自体はダミー関数に差し替わっているため、実際のメールは飛ばない）。
async function runAcV7({ supabase, buildApp, createRateLimiter, tagger }) {
  const id = 'AC-V7';
  const label = '同一メールアドレスは1時間に5通まで';
  const email = tagger.email('v7');
  const name = tagger.name('v7');

  // AC-V6と同じ理由でIP単位のリミッタだけを実質無制限にする。
  // メール単位・グローバル単位は検証対象そのものなので、本物のリミッタのまま使う。
  const looseIpLimiter = createRateLimiter(AC_V3_LOOSE_IP_LIMIT_WINDOW_MS, AC_V3_LOOSE_IP_LIMIT_MAX_REQUESTS);
  const app = buildApp({
    supabase,
    requestCodeIpLimiter: looseIpLimiter,
    sendSignupCodeEmail: dummySendEmail,
  });
  const { server, baseUrl } = await startServer(app);
  try {
    const attempts = [];
    for (let i = 0; i < AC_V7_TOTAL_REQUESTS; i++) {
      // 2回目以降は、直前の呼び出しでpending_signupsに書き込まれたcreated_atを
      // 【AC-V6と同じ手法で】61秒前に書き換えてから呼ぶ。そうしないと60秒クールダウンに
      // 引っかかり、検証したいメール単位上限（5通/時）にそもそも到達できないため。
      if (i > 0) {
        await rewritePendingSignupCreatedAtToPast(supabase, { email, secondsAgo: AC_V6_REWIND_SECONDS });
      }
      const res = await fetch(`${baseUrl}/api/signup/request-code`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, email }),
      });
      const bodyText = await res.text();
      attempts.push({ attempt: i + 1, status: res.status, body: bodyText.slice(0, 200) });
    }

    const first5 = attempts.slice(0, AC_V7_EMAIL_LIMIT);
    const sixth = attempts[AC_V7_EMAIL_LIMIT];

    const nonOkAmongFirst5 = first5.filter((a) => a.status !== 200);
    if (nonOkAmongFirst5.length > 0) {
      return {
        id,
        label,
        pass: false,
        summary: `${AC_V7_EMAIL_LIMIT}回目までに期待した200以外の応答が含まれていました（検証が成立していません）`,
        detail: `各回: ${JSON.stringify(attempts)}`,
      };
    }
    if (!sixth || sixth.status !== 429) {
      return {
        id,
        label,
        pass: false,
        summary: `${AC_V7_TOTAL_REQUESTS}回目が期待した429ではなくHTTP ${
          sixth ? sixth.status : '(未実行)'
        }でした（メール単位上限が効いていない・不合格）`,
        detail: `各回: ${JSON.stringify(attempts)}`,
      };
    }

    return {
      id,
      label,
      pass: true,
      summary: '',
      detail: `同一メールへ${AC_V7_TOTAL_REQUESTS}回要求し、${AC_V7_EMAIL_LIMIT}回目まではHTTP 200、${AC_V7_TOTAL_REQUESTS}回目はHTTP 429（上限超過）を確認しました。各回: ${JSON.stringify(
        attempts
      )}`,
    };
  } finally {
    await stopServer(server);
  }
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
    {
      id: 'AC-V4',
      label: 'anon からアクセスできない',
      run: () =>
        runAcV4({
          supabaseUrl,
          anonKey: process.env.SUPABASE_ANON_KEY,
          // 【AC-S13是正】RPC/テーブルの「存在確認」にsecretキーを使う（後述fetchSecretSchemaPaths）。
          secretKey: process.env.SUPABASE_SERVICE_KEY,
        }),
    },
    // 【追加3】AC-V5〜AC-V7。verify-codeのIP制限（10分20回・上書き不可）に対する
    // AC-V1(1)+AC-V2(5)+AC-V5(6)=12回の呼び出し回数は、この順序（AC-V1・V2が先に実行済み）
    // でも変わらない。AC-V6・AC-V7は本物のメール単位・グローバル単位の枠を消費するため、
    // 不正リクエストが枠を消費しないことを検証するAC-V3より後（この配列順）に実行する。
    { id: 'AC-V5', label: '確認コードは5回間違えると失効する', run: () => runAcV5({ supabase, buildApp, tagger }) },
    {
      id: 'AC-V6',
      label: '再送の60秒クールダウンが効く',
      run: () => runAcV6({ supabase, buildApp, createRateLimiter, tagger }),
    },
    {
      id: 'AC-V7',
      label: '同一メールアドレスは1時間に5通まで',
      run: () => runAcV7({ supabase, buildApp, createRateLimiter, tagger }),
    },
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
