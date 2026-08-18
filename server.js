require('dotenv').config();
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const cors = require('cors');
const webpush = require('web-push');
const { createClient } = require('@supabase/supabase-js');
const Stripe = require('stripe');
const { getJSTMonthStartISO } = require('./lib/time');
const { requireOwner } = require('./lib/auth');
const { createRateLimiter } = require('./lib/rateLimit');
const { validateReportInput } = require('./lib/reports');
const { performStoreWithdrawal, WithdrawalError, describeWithdrawalError } = require('./lib/withdrawal');
const {
  resolveSkipFreeTrial,
  verifySignupCode,
  requestSignupCode,
  SIGNUP_CODE_MAX_ATTEMPTS,
  SIGNUP_CODE_VERIFY_FAILED_MESSAGE,
} = require('./lib/signup');
// 管理者キー復旧（/api/recovery/*）。店舗登録とは別のテーブル・RPCを使う設計にした理由は
// lib/keyRecovery.js冒頭のコメントを参照。
const {
  requestKeyRecoveryCode,
  verifyKeyRecoveryCode,
  KEY_RECOVERY_CODE_MAX_ATTEMPTS,
  KEY_RECOVERY_VERIFY_FAILED_MESSAGE,
  respondWithPadding,
} = require('./lib/keyRecovery');

const PORT = process.env.PORT || 3000;

// 【L-5是正(独立再監査SECURITY_REVIEW_L5_FINAL2.md 中-2対応)】以前はここで
// SUPABASE_URL等の環境変数チェックとSupabaseクライアントの生成をモジュール読み込み時
// （＝requireした瞬間）に行っていた。そのためserver.jsはテストからrequireするだけで
// process.exit(1)するか、不正なURLでcreateClient()が例外を投げる作りになっており、
// テストは本体を一切requireできず（AC-L5-25）、レート制限などserver.js本体の実装を
// 壊してもテストが検出できなかった（開発担当のミューテーションテストで実証済み）。
// 環境変数チェックとクライアント生成はmain()の中（＝実際にサーバーを起動する時）まで
// 遅らせ、requireしただけでは副作用が起きないようにする。
// defaultSupabaseはmain()が起動時に代入するモジュール共有のクライアント。
// getConfig/setConfig/getMonthlyBroadcastCountなど、buildApp()の外側で定義されている
// ヘルパー関数はこちらを直接参照する。buildApp()内の各ルートは、テストからフェイクの
// クライアントを注入できるよう、別途ローカル変数として受け取る（下記buildApp()参照）。
let defaultSupabase = null;

// --- 課金（Stripe）関連の設定 ---
// STRIPE_SECRET_KEYが未設定でもアプリ自体は動く（決済ページの作成だけができない）。
const stripe = process.env.STRIPE_SECRET_KEY ? new Stripe(process.env.STRIPE_SECRET_KEY) : null;

const STRIPE_PRICES = {
  monthly: process.env.STRIPE_PRICE_MONTHLY,
  quarterly: process.env.STRIPE_PRICE_QUARTERLY,
  yearly: process.env.STRIPE_PRICE_YEARLY,
};

const PLAN_LABELS = {
  monthly: { label: '月額プラン', priceJPY: 980, interval: '1か月ごと' },
  quarterly: { label: '3か月プラン（20%OFF）', priceJPY: 2352, interval: '3か月ごと' },
  yearly: { label: '年間プラン（50%OFF）', priceJPY: 5880, interval: '1年ごと' },
};

// --- 店舗登録時のメール認証（Resend）関連の設定 ---
// 店舗名を変えて何度も登録し直すだけで無料期間（1か月間配信し放題）を取り続けられてしまう
// 悪用を防ぐため、実際に受信できるメールアドレスの確認コードを店舗作成の前に必須にしている。
// RESEND_API_KEYが未設定の場合、店舗登録（確認コード送信）自体ができない。
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const RESEND_FROM_EMAIL = process.env.RESEND_FROM_EMAIL || 'DAIDA+ <onboarding@resend.dev>';
const SIGNUP_CODE_TTL_MINUTES = 15;
const SIGNUP_CODE_RESEND_COOLDOWN_SECONDS = 60;

// --- 管理者キー復旧（/api/recovery/*）関連の設定 ---
// 管理者キーを失くすと店舗に二度と入れず、スタッフ全員に登録し直してもらう必要がある
// （導入時の最大の壁を再び越えることになる）うえ、有料プラン契約中なら使えないのに
// 引き落としだけ続く。店舗登録時のメールアドレス宛てに確認コードを送って本人確認したうえで
// 新しい管理者キーを発行する。設計判断・列挙対策の詳細はlib/keyRecovery.js冒頭を参照。
const KEY_RECOVERY_CODE_TTL_MINUTES = 15; // 店舗登録の確認コードと同じ有効期限

// 無料期間：店舗登録から1か月間は配信回数の制限なし
const FREE_TRIAL_MONTHS = 1;
// 無料期間終了後、毎月2回までは無料。3回目の配信からは有料プランが必要
const FREE_MONTHLY_BROADCASTS = 2;

// 登録項目（店舗名・スタッフ名）の文字数上限。
// 利用規約の禁止事項「登録項目の趣旨に反する情報（電話番号・生年月日等の個人情報）の入力」に
// 対応するための最低限のバリデーションの一部。長すぎる入力を防ぐ目的も兼ねる。
const STORE_NAME_MAX_LENGTH = 50;
const STAFF_NAME_MAX_LENGTH = 20;

// 退会処理でStripe解約後にDB操作が失敗した場合など、運営への問い合わせを案内する際の連絡先。
const SUPPORT_EMAIL = 'support@daida-store.jp';

// 通報（/api/report）を運営に知らせる通知メールの宛先。
// 通報はreportsテーブルに保存されるだけでは運営が気づけない（本番でテスト通報を送っても
// 誰も気づけなかった実例あり）ため、保存に成功したら必ずこの宛先へメールする。
// 環境変数で上書きできるが、未設定時に宛先が空になって通知が飛ばなくなる事態を防ぐため、
// 運営の問い合わせ窓口であるSUPPORT_EMAILへフォールバックする。
const REPORT_NOTIFICATION_EMAIL = process.env.REPORT_NOTIFICATION_EMAIL || SUPPORT_EMAIL;

// 通報API（/api/report）は管理者キーなしで誰でも呼べる仕様のため、荒らし対策として
// 同一IPからの短時間の大量送信を制限する（利用規約 第13条の通報機能）。
const REPORT_RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000; // 10分間
const REPORT_RATE_LIMIT_MAX_REQUESTS = 5; // 10分間に最大5件まで
const isReportRequestAllowed = createRateLimiter(REPORT_RATE_LIMIT_WINDOW_MS, REPORT_RATE_LIMIT_MAX_REQUESTS);

// 【M-3是正】IP単位の制限は、送信元IPを変更できる攻撃者（安価なプロキシ／VPSプールや
// IPv6の/64割当によるIPローテーション）には効かない。異なるIPを名乗り続けるだけで
// reportsテーブルへ事実上無制限にINSERTでき、Supabase無料枠（500MB）を枯渇させると、
// stores/subscriptions/shiftsも含む同一データベース全体が使えなくなり、
// 有料契約中の店舗も含めてサービスが全停止してしまう。
// そのため、送信元IPに依存しないサービス全体のグローバル上限を別途設ける。
//
// 上限値の根拠（1時間あたり200件）：
// 通報1件の最大サイズは、target(100字)+content(1000字)+reporter(50字)を日本語想定で
// UTF-8最大3バイト/字として計算すると約3.5KB、source_ip(64字)+user_agent(256字)や
// 行オーバーヘッドを加えても1件あたり概ね5KB以内に収まる。1時間200件を上限にすると
// 最悪でも増加量は約1MB/時間（約24MB/日）にとどまり、無料枠500MBに達するまでには
// 連続攻撃であっても数週間かかる計算になるため、その間に運営が使用量アラート等で
// 気付いて対処できる。一方、通報機能は本来ごく低頻度の機能であり、正常な利用で
// サービス全体で1時間に200件へ到達することは想定していない。
const REPORT_GLOBAL_RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000; // 1時間
const REPORT_GLOBAL_RATE_LIMIT_MAX_REQUESTS = 200; // サービス全体で1時間あたり最大200件まで
const isReportAllowedGlobally = createRateLimiter(REPORT_GLOBAL_RATE_LIMIT_WINDOW_MS, REPORT_GLOBAL_RATE_LIMIT_MAX_REQUESTS);
// グローバル制限は送信元に依存させないため、常に同じ固定キーで1つのカウンタを共有する。
const REPORT_GLOBAL_RATE_LIMIT_KEY = 'global';

// 【L-5是正】/api/signup/verify-code のIP単位レート制限（総当たり攻撃対策の補助）。
// 主対策は「1コードあたり最大SIGNUP_CODE_MAX_ATTEMPTS(5)回で失効」だが、それだけでは
// 「多数のメールアドレスを次々に登録し、それぞれ数回ずつ広く浅く総当たりする」攻撃を
// 止められない（コード単位のカウントはメールごとにリセットされてしまうため）。
// これを防ぐため、同一IPからのverify-code試行そのものにも上限を設ける。
//
// 上限値の根拠（10分あたり20回）：
// 正規利用者が1回の登録でコードを打ち間違える回数は現実的には数回（コピペミス・見間違い等）で、
// コード単位の上限(5回)に収まる。一方、店舗の共有Wi-Fi等、同一IP（グローバルIP）の背後に
// 複数人（オーナー・店長候補など）がいて、それぞれ別々に登録を試みるケースも考慮し、
// 「5回 × 数人ぶん」を許容できるよう10分間20回とした。これを超える試行は、正規利用では
// 想定しにくく、コードの正誤に関わらず遮断してよい水準と判断した。
// app.set('trust proxy', TRUSTED_PROXY_HOPS) 済みのため、req.ipは偽装できない（監査で実証済み）。
const VERIFY_CODE_IP_RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000; // 10分間
const VERIFY_CODE_IP_RATE_LIMIT_MAX_REQUESTS = 20; // 10分間に最大20回まで
const isVerifyCodeAllowedByIp = createRateLimiter(VERIFY_CODE_IP_RATE_LIMIT_WINDOW_MS, VERIFY_CODE_IP_RATE_LIMIT_MAX_REQUESTS);
// 検証失敗時のエラーメッセージ本体（コード不一致・期限切れ・上限到達で文言を区別しない）は
// lib/signup.js の SIGNUP_CODE_VERIFY_FAILED_MESSAGE を共有する（テストからも参照するため）。

// 【L-5是正(2周目・中-1)】/api/signup/request-code のレート制限。
// 是正前はこのエンドポイントに一切のレート制限が無く、認証不要で任意のメールアドレス宛てに
// 確認コードメールを送りつけられた（メール爆撃の踏み台）。加えて60秒クールダウンも
// read-modify-writeだったため同時実行で突破でき、監査PoCでは同時500件送信で被害者に
// 500通のメールが届くことが実証された（SECURITY_REVIEW_L5.md 中-1参照）。
// クールダウン自体はrequest_signup_code RPC（lib/signup.js）で原子化したが、それとは別に
// 「そもそも1つのIPが大量にメール送信を要求できる」こと自体を防ぐため、通報API(/api/report)
// と同じ二段構え（IP単位＋サービス全体）のレート制限を追加する。
//
// 上限値の根拠：
// - IP単位 1時間10通：正規利用では1つの端末から店舗登録を1時間に10回も試みることは
//   通常想定されない（打ち間違えて再送する場合でも数回程度）。
// - サービス全体 1時間300通：Resend等メール配信サービスの送信枠・送信レピュテーションを
//   保護するための最終防波堤。IPをローテーションする攻撃者にはIP単位の制限が効かないため、
//   送信元に依存しないグローバル上限が必要（/api/reportのグローバル制限と同じ考え方）。
const REQUEST_CODE_IP_RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000; // 1時間
const REQUEST_CODE_IP_RATE_LIMIT_MAX_REQUESTS = 10; // 1IPあたり1時間に10通まで
const isRequestCodeAllowedByIp = createRateLimiter(REQUEST_CODE_IP_RATE_LIMIT_WINDOW_MS, REQUEST_CODE_IP_RATE_LIMIT_MAX_REQUESTS);

// 【L-5是正(3周目・中-B対応)】グローバル上限（1時間300通）は「メール配信サービスの送信枠を
// 守る最終防波堤」であり撤去はしないが、独立再監査(SECURITY_REVIEW_L5_FINAL.md 中-B)で
// 「メールアドレスの妥当性チェックより前にカウンタを消費する」実装だったことが指摘された。
// この実装では、攻撃者は有効なメールアドレスすら不要で、不正なボディ（例:{"email":"x"}）を
// 30IP×10回=300回投げるだけでDBアクセス・メール送信を一切発生させずにグローバル枠を
// 使い切れてしまい、新規登録を恒久的に封じるDoSが成立する。
// 対策として、グローバル枠の消費は「実際にメールを送る直前」（＝request_signup_code RPCで
// クールダウン判定を通過し、本当に送信することが確定した時点）まで遅らせる
// （下のapp.post('/api/signup/request-code', ...)内を参照。不正なボディやクールダウン中の
// 429ではここを通過しないため、枠は消費されない。AC-L5-19）。
const REQUEST_CODE_GLOBAL_RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000; // 1時間
const REQUEST_CODE_GLOBAL_RATE_LIMIT_MAX_REQUESTS = 300; // サービス全体で1時間あたり最大300通まで
const isRequestCodeAllowedGlobally = createRateLimiter(
  REQUEST_CODE_GLOBAL_RATE_LIMIT_WINDOW_MS,
  REQUEST_CODE_GLOBAL_RATE_LIMIT_MAX_REQUESTS
);
// グローバル制限は送信元に依存させないため、常に同じ固定キーで1つのカウンタを共有する。
const REQUEST_CODE_GLOBAL_RATE_LIMIT_KEY = 'global';

// 【L-5是正(3周目・中-B対応)】メールアドレス単位の上限を新設する。IPをローテーションする
// 攻撃者にはIP単位の制限（1時間10通）が効かないため、送信先メールアドレス単位でも
// 上限を設けることで、1メールアドレスへの総当たりレートを 300回/時（5回/コード×60コード/時）
// から 25回/時（5回/コード×5コード/時）に引き下げる（独立再監査の修正案どおり）。
// キーには生のメールアドレスをそのまま使わず、hashKey()でハッシュ化した値を使う
// （生アドレスをレート制限用のメモリ上に長時間置かないため）。
const REQUEST_CODE_EMAIL_RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000; // 1時間
const REQUEST_CODE_EMAIL_RATE_LIMIT_MAX_REQUESTS = 5; // 同一メールアドレスへは1時間5通まで
const isRequestCodeAllowedByEmail = createRateLimiter(
  REQUEST_CODE_EMAIL_RATE_LIMIT_WINDOW_MS,
  REQUEST_CODE_EMAIL_RATE_LIMIT_MAX_REQUESTS
);

// 【管理者キー復旧】/api/recovery/verify-code のIP単位レート制限。
// 考え方は/api/signup/verify-code（L-5是正）と全く同じ。総当たり対策の主軸はコード単位の
// 試行回数制限（KEY_RECOVERY_CODE_MAX_ATTEMPTS）だが、複数のメールアドレスを横断して
// 広く浅く総当たりする攻撃を止める補助として、同一IPからの試行回数にも上限を設ける。
// 値は店舗登録のVERIFY_CODE_IP_RATE_LIMIT_*と同じ根拠のため、同じ値を採用する。
const RECOVERY_VERIFY_CODE_IP_RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000; // 10分間
const RECOVERY_VERIFY_CODE_IP_RATE_LIMIT_MAX_REQUESTS = 20; // 10分間に最大20回まで
const isRecoveryVerifyCodeAllowedByIp = createRateLimiter(
  RECOVERY_VERIFY_CODE_IP_RATE_LIMIT_WINDOW_MS,
  RECOVERY_VERIFY_CODE_IP_RATE_LIMIT_MAX_REQUESTS
);

// 【管理者キー復旧】/api/recovery/request-code のレート制限（IP・メール・グローバルの3層）。
// 店舗登録のrequest-code（REQUEST_CODE_*）と同じ3層構造・同じ根拠の数値を採用する
// （「既存のものを再利用するほうが安全」という方針に基づき、実績のある値をそのまま流用する）。
const RECOVERY_REQUEST_CODE_IP_RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000; // 1時間
const RECOVERY_REQUEST_CODE_IP_RATE_LIMIT_MAX_REQUESTS = 10; // 1IPあたり1時間に10回まで
const isRecoveryRequestCodeAllowedByIp = createRateLimiter(
  RECOVERY_REQUEST_CODE_IP_RATE_LIMIT_WINDOW_MS,
  RECOVERY_REQUEST_CODE_IP_RATE_LIMIT_MAX_REQUESTS
);

const RECOVERY_REQUEST_CODE_GLOBAL_RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000; // 1時間
const RECOVERY_REQUEST_CODE_GLOBAL_RATE_LIMIT_MAX_REQUESTS = 300; // サービス全体で1時間あたり最大300通まで
const isRecoveryRequestCodeAllowedGlobally = createRateLimiter(
  RECOVERY_REQUEST_CODE_GLOBAL_RATE_LIMIT_WINDOW_MS,
  RECOVERY_REQUEST_CODE_GLOBAL_RATE_LIMIT_MAX_REQUESTS
);
const RECOVERY_REQUEST_CODE_GLOBAL_RATE_LIMIT_KEY = 'global';

// メールアドレス単位の上限。店舗登録のREQUEST_CODE_EMAIL_RATE_LIMIT_*と同じ値。
// キーには生のメールアドレスではなくhashKey()した値を使う（下記ルート内で使用）。
const RECOVERY_REQUEST_CODE_EMAIL_RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000; // 1時間
const RECOVERY_REQUEST_CODE_EMAIL_RATE_LIMIT_MAX_REQUESTS = 5; // 同一メールアドレスへは1時間5通まで
const isRecoveryRequestCodeAllowedByEmail = createRateLimiter(
  RECOVERY_REQUEST_CODE_EMAIL_RATE_LIMIT_WINDOW_MS,
  RECOVERY_REQUEST_CODE_EMAIL_RATE_LIMIT_MAX_REQUESTS
);

// 【管理者キー復旧・列挙対策（AC-K6）】メールアドレスが登録済みかどうかで応答時間が変わると、
// 「このメールアドレスは店舗として登録されているか」を推測する材料（タイミングオラクル）に
// なってしまう。登録済みの場合は実際にResend APIへの送信（ネットワーク往復）が発生し、
// 未登録の場合は何もしない（往復が発生しない）ため、対策しなければ数百ms単位の
// 顕著な差が生まれる。これを隠すため、DB照会〜メール送信までの区間の所要時間を、
// 常にこの下限までパディングする（Resend APIの典型的な応答時間より余裕を持たせた値。
// 実測に基づく厳密な値ではないため、疑わしきは長め＝安全側に倒している）。
const KEY_RECOVERY_REQUEST_MIN_RESPONSE_TIME_MS = 400;
// 検証（/api/recovery/verify-code）はDB照会のみで完結し、found/not-foundの処理量の差も
// request-codeほど大きくない（外部ネットワーク呼び出しが無い）が、念のため同様の
// パディングを適用する。値は小さめでよい。
const KEY_RECOVERY_VERIFY_MIN_RESPONSE_TIME_MS = 100;

// 通報の証跡として記録するIPアドレス・User-Agentの最大文字数。
// ヘッダ由来の値をそのままDBに保存すると、異常に長い値でストレージを圧迫し得るため上限を設ける。
const REPORT_SOURCE_IP_MAX_LENGTH = 64;
const REPORT_USER_AGENT_MAX_LENGTH = 256;

// 同じメールアドレスで2店舗目以降を登録した場合は skip_free_trial が true になっており、
// その場合は無料期間を「登録した瞬間に終わっている」ものとして扱う（＝最初から
// 「毎月2回まで無料」の通常運用と同じ扱いになる）。店舗名を変えて無料期間だけを
// 繰り返し取得する悪用を防ぐための仕組み。
function trialEndsAt(store) {
  if (store.skip_free_trial) {
    return new Date(store.created_at);
  }
  const end = new Date(store.created_at);
  end.setMonth(end.getMonth() + FREE_TRIAL_MONTHS);
  return end;
}

function hasActiveSubscription(store) {
  return (
    store.subscription_status === 'active' &&
    !!store.current_period_end &&
    new Date(store.current_period_end) > new Date()
  );
}

function planFromPriceId(priceId) {
  if (!priceId) return null;
  if (priceId === process.env.STRIPE_PRICE_MONTHLY) return 'monthly';
  if (priceId === process.env.STRIPE_PRICE_QUARTERLY) return 'quarterly';
  if (priceId === process.env.STRIPE_PRICE_YEARLY) return 'yearly';
  return null;
}

// その店舗が「今月すでに何回配信したか」をshiftsテーブルから数える
// （専用カウンターテーブルを持たず、実績から毎回集計することで月替わりの処理を単純化している）
async function getMonthlyBroadcastCount(storeId) {
  // サーバーのローカル時刻（Renderの場合はUTC）ではなく、日本時間（JST）基準で月初を算出する。
  // これにより、日本時間8/1 0:00〜9:00の配信もUTC基準の「前月扱い」にならず正しく当月分として数えられる。
  const startOfMonth = getJSTMonthStartISO();
  const { count, error } = await defaultSupabase
    .from('shifts')
    .select('*', { count: 'exact', head: true })
    .eq('store_id', storeId)
    .gte('created_at', startOfMonth);
  if (error) throw error;
  return count || 0;
}

// 配信してよいかどうかを判定する。
// 1. 登録から1か月以内 → 無条件で許可（無料期間）
// 2. 有料プラン契約中（current_period_end内） → 許可
// 3. それ以外 → 今月の配信回数が2回未満なら許可、2回以上なら要アップグレード
async function checkBroadcastAllowed(store) {
  const now = new Date();
  if (now < trialEndsAt(store)) {
    return { allowed: true, reason: 'trial' };
  }
  if (hasActiveSubscription(store)) {
    return { allowed: true, reason: 'subscribed' };
  }
  const countThisMonth = await getMonthlyBroadcastCount(store.id);
  if (countThisMonth >= FREE_MONTHLY_BROADCASTS) {
    return { allowed: false, reason: 'quota_exceeded', countThisMonth };
  }
  return { allowed: true, reason: 'free_quota', countThisMonth };
}

// 店舗は「店舗名の文字列一致」ではなく、自動採番されるID(stores.id)で区別する。
// これにより、別々の会社が同じ店舗名（例："牛久店"）を使っても内部的には別物として扱われ、
// データが混ざることはない。
// 管理者キーは店長が自己登録した際にランダム生成され、DBにはハッシュ値のみ保存する
// （生の値はDBが漏れても使えない。ログイン時は同じ方法でハッシュ化して一致するものを検索する）。
function generateAdminKey() {
  return crypto.randomBytes(20).toString('hex'); // 40文字のランダムな文字列
}
function hashKey(key) {
  return crypto.createHash('sha256').update(key).digest('hex');
}

// 店舗登録時のメール確認用の6桁コードを生成する
function generateSignupCode() {
  return String(crypto.randomInt(100000, 1000000));
}

function isValidEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || ''));
}

// Resend（https://resend.com）のAPIを使って確認コードのメールを送る。
// SDKは使わず素朴にfetchで叩く（依存を増やさないため。Node18+のグローバルfetchを利用）。
async function sendSignupCodeEmail(email, code) {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: RESEND_FROM_EMAIL,
      to: email,
      subject: 'DAIDA+ 店舗登録の確認コード',
      html: `
        <p>DAIDA+の店舗登録ありがとうございます。</p>
        <p>以下の確認コードを登録画面に入力してください（${SIGNUP_CODE_TTL_MINUTES}分間有効です）。</p>
        <p style="font-size:28px; font-weight:bold; letter-spacing:4px;">${code}</p>
        <p>心当たりがない場合は、このメールは破棄してください。</p>
      `,
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Resend API error: ${res.status} ${text}`);
  }
}

// Resendを使って管理者キー復旧の確認コードメールを送る（sendSignupCodeEmailと同じ方式）。
// 本人が要求していない場合に気づけるよう、「心当たりがない場合は破棄してください」の一文を
// 必ず含める（何もしなければキーは変わらないことも明記し、慌てさせない）。
// storeNameはユーザーが店舗登録時に自由入力した値のため、HTMLメール本文に埋め込む前に
// escapeHtmlする（通報通知メールと同じ理由。タグ等を仕込まれても表示が壊れないようにする）。
async function sendKeyRecoveryCodeEmail(email, code, storeName) {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: RESEND_FROM_EMAIL,
      to: email,
      subject: 'DAIDA+ 管理者キーの再発行 確認コード',
      html: `
        <p>「${escapeHtml(storeName)}」の管理者キー再発行のご依頼を受け付けました。</p>
        <p>以下の確認コードを画面に入力してください（${KEY_RECOVERY_CODE_TTL_MINUTES}分間有効です）。</p>
        <p style="font-size:28px; font-weight:bold; letter-spacing:4px;">${code}</p>
        <p><strong>このコードを入力すると、現在の管理者キーは無効になり、新しい管理者キーが発行されます。</strong>時間帯責任者キーはそのまま引き続きお使いいただけます。</p>
        <p>この操作に心当たりがない場合は、このメールを破棄してください。何もしなければ管理者キーは変更されません。</p>
        <p><strong>管理者キーが第三者に漏れた可能性がある場合は、</strong>時間帯責任者キーの再発行だけでは対処できません。ログイン後、店長用ダッシュボードの「時間帯責任者の管理」から発行済みのキー一覧を確認し、心当たりのないものは失効させてください。</p>
      `,
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Resend API error: ${res.status} ${text}`);
  }
}

// 通報通知メールの本文（HTML）に、通報対象・通報内容・通報者など利用者の自由入力文字列を
// そのまま埋め込むため、埋め込み前に最低限のHTMLエスケープを行う。これを怠ると、
// 通報内容にHTMLタグを仕込まれた場合に運営側のメール表示が崩れたり、意図しないリンク等が
// 埋め込まれるおそれがある。
function escapeHtml(value) {
  const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  return String(value == null ? '' : value).replace(/[&<>"']/g, (ch) => map[ch]);
}

// 通報（利用規約 第13条）がreportsテーブルに保存できたことを運営に知らせる通知メール。
// 【背景】通報はDBに保存されるだけでは運営が気づけず、実際に本番でテスト通報を送っても
// 誰も気づけない状態だった。第13条2項の「合理的な調査」を行うには、まず通報の発生に
// 運営が気づける必要があるため、このメールで気づける状態にする。
// sendSignupCodeEmailと同じ方式（Resendの/emails APIをSDKなしでfetchする素朴な実装。
// Node18+のグローバルfetchを利用）で送る。
// メールを見るだけで判断できるよう、通報内容をそのまま（escapeHtmlした上で）本文に載せる。
// 送信元IPも含める（独立監査で「証跡が残らず虚偽通報を技術的に判別できない」（中-2）と
// 指摘され、通報の真偽を運営が判断する材料として記録するようにした経緯がある。
// ここで使うsourceIpは、reportsテーブルへの保存時に使ったのと同じ値を再利用するだけで、
// このメール送信のために新たな取得を行うわけではない）。
async function sendReportNotificationEmail({ receivedAt, target, content, reporter, storeId, sourceIp }) {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: RESEND_FROM_EMAIL,
      to: REPORT_NOTIFICATION_EMAIL,
      subject: '【DAIDA+】通報を受け付けました',
      html: `
        <p>DAIDA+に新しい通報が届きました。内容をご確認のうえ、必要な調査をお願いします（利用規約 第13条2項）。</p>
        <ul>
          <li>受信日時: ${escapeHtml(receivedAt)}</li>
          <li>通報対象: ${escapeHtml(target)}</li>
          <li>通報内容: ${escapeHtml(content)}</li>
          <li>通報者（自己申告・任意）: ${escapeHtml(reporter || '（未入力）')}</li>
          <li>店舗ID: ${escapeHtml(storeId || '（未指定/該当する店舗なし）')}</li>
          <li>送信元IP: ${escapeHtml(sourceIp)}</li>
        </ul>
      `,
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Resend API error: ${res.status} ${text}`);
  }
}

// 代打（欠員募集）が確定したことを、店舗のメールアドレス（stores.email）宛に知らせる通知メール。
// 【背景】応募が確定すると shifts.status が 'filled' になるだけで、店長には何も通知されず、
// manager.htmlの「募集状況」を開いて「🔄更新」を押すまで気づけなかった。欠勤の穴埋めは
// 急ぎの場面であるにもかかわらず、「決まったか気になって何度もアプリを開く」手間が残っており、
// これはこのアプリの価値（LINEで一人ずつ聞いて回る手間をなくすこと）を損なう穴だった。
// sendReportNotificationEmailと同じ方式（Resendの/emails APIをSDKなしでfetchする素朴な実装。
// Node18+のグローバルfetchを利用）で送る。
// filledBy（応募者名）・note（補足）・storeName（店舗名）はいずれも利用者の自由入力のため、
// 通報通知メールと同じ理由でescapeHtmlしてから本文に埋め込む（タグを仕込まれても表示が
// 崩れないようにする）。
// 件名だけでも「決まったこと」と「いつのシフトか」が分かるようにする。店長はスマホの
// 通知画面でこれを見ることが多く、本文を開かなくても急ぎの用件だと判断できる必要があるため。
async function sendShiftFilledNotificationEmail({ storeEmail, storeName, filledBy, date, time, note }) {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: RESEND_FROM_EMAIL,
      to: storeEmail,
      subject: `【DAIDA+】代打が決まりました（${date} ${time}）`,
      html: `
        <p>「${escapeHtml(storeName)}」の代打募集に応募があり、確定しました。</p>
        <ul>
          <li>応募したスタッフ: ${escapeHtml(filledBy)}</li>
          <li>日付: ${escapeHtml(date)}</li>
          <li>時間: ${escapeHtml(time)}</li>
          ${note ? `<li>補足: ${escapeHtml(note)}</li>` : ''}
        </ul>
      `,
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Resend API error: ${res.status} ${text}`);
  }
}

// 店舗名・スタッフ名は「その項目の趣旨（店舗を識別する名称／人を呼ぶための名前）」以外の
// 個人情報（電話番号・生年月日・性別・メールアドレス等）が入力されていないかを簡易チェックする。
// 完全な防止策ではなく、明らかに不適切な入力をサーバー側で弾くための最低限のバリデーション。
// クライアント側（public/index.html・public/signup.html）にも同等のチェックがあるが、
// クライアント側だけの制限は回避可能なため、必ずサーバー側でも検証する。
function findPersonalInfoIssue(value) {
  const v = String(value || '');

  // 合計4桁以上の数字（電話番号・生年月日・郵便番号などの恐れがある）
  const digitCount = (v.match(/\d/g) || []).length;
  if (digitCount >= 4) {
    return '電話番号や生年月日など、数字を含む個人情報は入力しないでください';
  }

  // メールアドレス形式
  if (/[^\s@]+@[^\s@]+\.[^\s@]+/.test(v)) {
    return 'メールアドレスは入力しないでください';
  }

  // 性別を明示する単語
  if (/(男性|女性|male|female)/i.test(v)) {
    return '性別などの個人情報は入力しないでください';
  }

  return null;
}

// shiftsテーブルの行(snake_case)をフロントエンドが期待する形に変換
function mapShift(row) {
  return {
    id: row.id,
    storeId: row.store_id,
    store_name: row.store_name,
    date: row.date,
    time: row.time,
    note: row.note || '',
    status: row.status,
    filledBy: row.filled_by,
    filledAt: row.filled_at,
    createdAt: row.created_at,
  };
}

async function getConfig(key) {
  const { data, error } = await defaultSupabase.from('app_config').select('value').eq('key', key).maybeSingle();
  if (error) throw error;
  return data ? data.value : null;
}

async function setConfig(key, value) {
  const { error } = await defaultSupabase.from('app_config').upsert({ key, value });
  if (error) throw error;
}

// --- VAPID鍵：初回のみ生成し、以後はSupabase(app_config)に保存して使い回す ---
// ローカルファイルに保存する方式だとRenderの無料プランではスリープのたびに消えてしまうため、
// 外部DBであるSupabaseに保存することで、サーバーが何度再起動・スリープしても鍵が変わらないようにする。
async function loadOrCreateVapidKeys() {
  const [publicKey, privateKey] = await Promise.all([getConfig('vapid_public_key'), getConfig('vapid_private_key')]);
  if (publicKey && privateKey) return { publicKey, privateKey };

  const keys = webpush.generateVAPIDKeys();
  await setConfig('vapid_public_key', keys.publicKey);
  await setConfig('vapid_private_key', keys.privateKey);
  console.log('🔑 新しいVAPID鍵を生成しました（Supabaseのapp_configテーブルに保存済み。以後はこれを使い回します）');
  return keys;
}

// buildApp()内の /api/vapid-public-key から参照する。main()が起動時に代入する
// （requireしただけでは未設定のnullのままだが、そのルートを叩かない限り問題にならない）。
let sharedVapidKeys = null;

// 【L-5是正(独立再監査SECURITY_REVIEW_L5_FINAL2.md 中-2対応)】
// Expressアプリの構築（ミドルウェア・全ルートの登録）を、起動処理（VAPID鍵のロード・
// Supabase接続・app.listen()）から切り離した関数。requireされただけでは呼び出されない
// ため、これ自体に副作用は無い（AC-L5-25）。
// overrides.supabase を渡すと、そのルート内で使うSupabaseクライアントを差し替えられる。
// overrides.requestCodeIpLimiter / requestCodeEmailLimiter / requestCodeGlobalLimiter は
// /api/signup/request-code のレート制限器を差し替える。省略時（＝本番）は、
// 常にモジュールスコープの本物のリミッター・Supabaseクライアントを使うため、
// このパラメータの存在自体が本番の挙動を変えることはない。
// これにより、テストは複製ハンドラを書かずに、server.jsが実際に構築したこの関数の
// 戻り値（Expressアプリ）そのものを検証できる（AC-L5-26。lib/rateLimit.jsの本物の
// createRateLimiterで小さい上限のリミッターを作って注入すれば、実際のクールダウンや
// グローバル上限(300/時)を待たずに高速にテストできる）。
function buildApp(overrides = {}) {
  const supabase = overrides.supabase || defaultSupabase;
  const app = express();

  // Render等リバースプロキシ配下で動くため、req.ip がプロキシのIPにならないよう
  // X-Forwarded-Forを信頼する設定にする（通報APIのレート制限をIPベースで正しく行うために必要）。
  // 【重要】trueを指定するとX-Forwarded-Forの全ホップ（＝クライアントが自由に書ける最左値）を
  // 信頼してしまい、攻撃者がヘッダを毎回書き換えるだけでIPベースのレート制限を無制限に回避できる。
  // Renderの前段プロキシは1段のみのため、ホップ数を1に固定し、Renderが実際に付与した
  // 実IP（右から1番目）だけを信頼する。
  // 【L-9】この値は「前段プロキシがちょうど1段」であるRenderへの直接デプロイ構成が前提。CDN等を前段に追加する場合はこの値の見直しが必要。
  const TRUSTED_PROXY_HOPS = 1;
  app.set('trust proxy', TRUSTED_PROXY_HOPS);

  app.use(cors());

  // Stripe Webhookはリクエストボディの生データ（raw body）が必要なため、
  // 全体にexpress.json()をかける前に、このルートだけ個別に登録する。
  app.post('/api/stripe-webhook', express.raw({ type: 'application/json' }), async (req, res) => {
    if (!stripe || !process.env.STRIPE_WEBHOOK_SECRET) {
      return res.status(500).send('Stripe webhook is not configured');
    }
    let event;
    try {
      event = stripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'], process.env.STRIPE_WEBHOOK_SECRET);
    } catch (err) {
      console.error('Webhook signature verification failed:', err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    try {
      // 同じイベントを二重処理しないための簡易チェック
      const { error: dupCheckErr } = await supabase.from('stripe_events').insert({ id: event.id });
      if (dupCheckErr && dupCheckErr.code === '23505') {
        // 既に処理済みのイベント（一意制約違反）
        return res.json({ received: true, duplicate: true });
      }

      switch (event.type) {
        case 'checkout.session.completed': {
          const session = event.data.object;
          const storeId = session.metadata && session.metadata.store_id;
          if (storeId && session.subscription) {
            const sub = await stripe.subscriptions.retrieve(session.subscription);
            const plan = planFromPriceId(sub.items.data[0].price.id);
            await supabase
              .from('stores')
              .update({
                stripe_customer_id: session.customer,
                stripe_subscription_id: sub.id,
                subscription_status: sub.status,
                subscription_plan: plan,
                current_period_end: new Date(sub.current_period_end * 1000).toISOString(),
              })
              .eq('id', storeId);
          }
          break;
        }
        case 'customer.subscription.updated':
        case 'customer.subscription.deleted': {
          const sub = event.data.object;
          const storeId = sub.metadata && sub.metadata.store_id;
          if (storeId) {
            const plan = sub.items && sub.items.data[0] ? planFromPriceId(sub.items.data[0].price.id) : null;
            await supabase
              .from('stores')
              .update({
                subscription_status: event.type === 'customer.subscription.deleted' ? 'canceled' : sub.status,
                subscription_plan: plan,
                current_period_end: sub.current_period_end ? new Date(sub.current_period_end * 1000).toISOString() : null,
              })
              .eq('id', storeId);
          }
          break;
        }
        default:
          break;
      }
      res.json({ received: true });
    } catch (err) {
      console.error('webhook handling error:', err);
      res.status(500).send('Webhook handler error');
    }
  });

  app.use(express.json());
  app.use(express.static(path.join(__dirname, 'public')));

  // M-3: 深夜勤務（22時〜翌5時）判定ロジックは、店長ダッシュボード（ブラウザ側）でも
  // 配信前の警告表示に使うため、このファイルのみを静的公開する。lib/ ディレクトリ全体を
  // 公開するとサーバー内部ロジック（認証・レート制限等）まで露出してしまうため、
  // 個別のルートで対象を1ファイルに絞る。
  app.get('/lib/nightWork.js', (req, res) => {
    res.sendFile(path.join(__dirname, 'lib', 'nightWork.js'));
  });

  // 店長用エンドポイントの認証。管理者キーをハッシュ化し、まずオーナー用の
  // stores.admin_key_hash と一致するか調べ、一致しなければ時間帯責任者用の
  // supervisor_keys.admin_key_hash と一致するかを調べる。どちらかに一致すれば
  // その店舗のIDを req.storeId に入れ、役割を req.role（'owner' | 'supervisor'）に入れる。
  // これにより、権限を持たない他店舗の情報は見えない・操作できない状態になる。
  // 課金判定に使う情報もあわせて req.store に入れる（時間帯責任者にも入るが、
  // 実際に契約・料金系のAPIを叩けるのは requireOwner を通したエンドポイントのみ）。
  async function requireAdmin(req, res, next) {
    const key = req.headers['x-admin-key'];
    if (!key) {
      return res.status(401).json({ error: '認証エラー：管理者キーが違います' });
    }
    try {
      const keyHash = hashKey(key);
      let storeId = null;
      let role = null;

      const { data: ownerStore, error: ownerErr } = await supabase
        .from('stores')
        .select('id')
        .eq('admin_key_hash', keyHash)
        .maybeSingle();
      if (ownerErr) throw ownerErr;

      if (ownerStore) {
        storeId = ownerStore.id;
        role = 'owner';
      } else {
        const { data: supervisor, error: supErr } = await supabase
          .from('supervisor_keys')
          .select('store_id')
          .eq('admin_key_hash', keyHash)
          .maybeSingle();
        if (supErr) throw supErr;
        if (supervisor) {
          storeId = supervisor.store_id;
          role = 'supervisor';
        }
      }

      if (!storeId) {
        return res.status(401).json({ error: '認証エラー：管理者キーが違います' });
      }

      const { data: store, error } = await supabase
        .from('stores')
        .select(
          'id, name, email, created_at, subscription_status, subscription_plan, stripe_customer_id, stripe_subscription_id, current_period_end, skip_free_trial'
        )
        .eq('id', storeId)
        .maybeSingle();
      if (error) throw error;
      if (!store) {
        return res.status(401).json({ error: '認証エラー：管理者キーが違います' });
      }
      req.storeId = store.id;
      req.storeName = store.name;
      req.store = store;
      req.role = role;
      next();
    } catch (err) {
      console.error('auth error:', err);
      res.status(500).json({ error: '認証に失敗しました' });
    }
  }

  // requireOwner（オーナー・店長専用の操作を守るミドルウェア。スタッフ管理・料金確認・
  // 契約更新・プラン変更・解約・支払方法変更・時間帯責任者の発行/失効・店舗の退会が対象）は
  // 外部サービスに依存しない純粋なロジックのため lib/auth.js に切り出し、ユニットテストで
  // 直接検証できるようにしている（このファイル冒頭でrequire済み）。

  // 外形監視(UptimeRobot等)からの死活確認用。DBに触らず即応答するので軽い。
  // Renderの無料プランは15分無アクセスでスリープするため、これを5〜10分おきにpingすると
  // スリープを回避できる（月750時間の無料枠内に収まる想定。詳細はDEPLOY.md参照）。
  app.get('/health', (req, res) => {
    res.status(200).send('ok');
  });

  // 公開鍵を配布するエンドポイント（sharedVapidKeysはmain()が起動時に設定する）
  app.get('/api/vapid-public-key', (req, res) => {
    res.json({ publicKey: sharedVapidKeys ? sharedVapidKeys.publicKey : null });
  });

  // 店長の自己登録 手順1：メールアドレス宛てに6桁の確認コードを送る。
  // 店舗名を変えるだけで無料期間（1か月間配信し放題）を何度も取り直す悪用を防ぐため、
  // 実際に受信できるメールアドレスの確認を店舗作成の前に必須にしている。
  // 【L-5是正(独立再監査 中-2対応)】このルートのレート制限器は、テストから注入できるよう
  // overridesで差し替え可能にしている。省略時（＝本番）は常にモジュールスコープの本物の
  // リミッターを使うため、以下の3行はどのオーバーライドも渡さない本番の挙動を一切変えない。
  const requestCodeIpLimiter = overrides.requestCodeIpLimiter || isRequestCodeAllowedByIp;
  const requestCodeEmailLimiter = overrides.requestCodeEmailLimiter || isRequestCodeAllowedByEmail;
  const requestCodeGlobalLimiter = overrides.requestCodeGlobalLimiter || isRequestCodeAllowedGlobally;
  // メール送信の実体（Resend APIへの実際のfetch）もテストから差し替え可能にする。
  // これにより、テストは実際に外部へメールを送信することなく、
  // 「送信が確定した」ことだけを検証できる（省略時＝本番は本物のsendSignupCodeEmailを使う）。
  const sendSignupCodeEmailFn = overrides.sendSignupCodeEmail || sendSignupCodeEmail;
  // 通報の通知メール（Resend APIへの実際のfetch）も同様にテストから差し替え可能にする。
  // これにより、テストは実際に外部へメールを送信することなく、
  // 「メール送信が失敗しても通報の受付自体は201で成功すること」（AC-R3）を検証できる
  // （省略時＝本番は本物のsendReportNotificationEmailを使う）。
  const sendReportNotificationEmailFn = overrides.sendReportNotificationEmail || sendReportNotificationEmail;
  // 代打確定の通知メール（Resend APIへの実際のfetch）も同様にテストから差し替え可能にする。
  // これにより、テストは実際に外部へメールを送信することなく、「メール送信が失敗しても
  // 応募の確定は成功として扱われること」（AC-N3）や「応答はメール送信を待たないこと」（AC-N5）
  // を検証できる（省略時＝本番は本物のsendShiftFilledNotificationEmailを使う）。
  const sendShiftFilledNotificationEmailFn =
    overrides.sendShiftFilledNotificationEmail || sendShiftFilledNotificationEmail;

  // 管理者キー復旧（/api/recovery/*）のレート制限器・メール送信・応答パディングの下限も、
  // 上記と同じ理由でoverridesから差し替え可能にする（省略時＝本番の挙動は一切変わらない）。
  const recoveryRequestCodeIpLimiter = overrides.recoveryRequestCodeIpLimiter || isRecoveryRequestCodeAllowedByIp;
  const recoveryRequestCodeEmailLimiter = overrides.recoveryRequestCodeEmailLimiter || isRecoveryRequestCodeAllowedByEmail;
  const recoveryRequestCodeGlobalLimiter = overrides.recoveryRequestCodeGlobalLimiter || isRecoveryRequestCodeAllowedGlobally;
  const recoveryVerifyCodeIpLimiter = overrides.recoveryVerifyCodeIpLimiter || isRecoveryVerifyCodeAllowedByIp;
  const sendKeyRecoveryCodeEmailFn = overrides.sendKeyRecoveryCodeEmail || sendKeyRecoveryCodeEmail;
  // AC-K6のタイミング対策の下限値。テストは通常0を注入して高速化するが、本番は必ず
  // 上のモジュールスコープの値（400ms/100ms）を使う。
  const keyRecoveryRequestMinResponseTimeMs =
    overrides.keyRecoveryRequestMinResponseTimeMs != null
      ? overrides.keyRecoveryRequestMinResponseTimeMs
      : KEY_RECOVERY_REQUEST_MIN_RESPONSE_TIME_MS;
  const keyRecoveryVerifyMinResponseTimeMs =
    overrides.keyRecoveryVerifyMinResponseTimeMs != null
      ? overrides.keyRecoveryVerifyMinResponseTimeMs
      : KEY_RECOVERY_VERIFY_MIN_RESPONSE_TIME_MS;

  app.post('/api/signup/request-code', async (req, res) => {
    // 【L-5是正(2周目・中-1)】まずIP単位のレート制限を確認する。不正なボディであっても
    // 同一IPからの大量送信自体は早期に弾いておきたいため、ここは従来どおりバリデーション前に行う。
    // 【L-5是正(3周目・中-B対応）】ただしグローバル上限（サービス全体で1時間300通）は
    // ここでは消費しない。以前はここでグローバル枠も同時に消費していたため、メールアドレスの
    // 妥当性チェックより前にカウンタが減ってしまい、攻撃者は有効なメールアドレスすら使わず
    // 不正なボディ（例:{"email":"x"}）を撒くだけでDBアクセス・メール送信を一切発生させずに
    // グローバル枠を使い切り、新規登録を恒久的に封じることができた（独立再監査 中-B）。
    // グローバル枠の消費は、実際にメールを送ることが確定する箇所（下記）まで遅らせる。
    const clientIp = req.ip || (req.connection && req.connection.remoteAddress) || 'unknown';
    if (!requestCodeIpLimiter(clientIp)) {
      return res
        .status(429)
        .json({ error: '確認コードの送信要求が多すぎます。しばらくしてから再度お試しください' });
    }

    const name = ((req.body && req.body.name) || '').trim();
    const email = ((req.body && req.body.email) || '').trim().toLowerCase();

    if (!name) {
      return res.status(400).json({ error: '店舗名を入力してください' });
    }
    if (name.length > STORE_NAME_MAX_LENGTH) {
      return res.status(400).json({ error: `店舗名は${STORE_NAME_MAX_LENGTH}文字以内で入力してください` });
    }
    const personalInfoIssue = findPersonalInfoIssue(name);
    if (personalInfoIssue) {
      return res.status(400).json({ error: personalInfoIssue });
    }
    if (!isValidEmail(email)) {
      return res.status(400).json({ error: '正しいメールアドレスを入力してください' });
    }
    if (!RESEND_API_KEY) {
      return res.status(500).json({ error: 'メール認証機能が設定されていません（管理者にお問い合わせください）' });
    }

    try {
      const code = generateSignupCode();
      const expiresAt = new Date(Date.now() + SIGNUP_CODE_TTL_MINUTES * 60 * 1000).toISOString();

      // 【L-5是正(2周目・中-1)】「直近送信の確認→60秒経過の判定→古い行の削除→新しい行の挿入」を
      // 単一の原子的なSQL文(RPC)にまとめる。旧実装は複数文のread-modify-writeで、
      // 同時多発リクエストが全員クールダウン判定をすり抜けられた（監査PoC実証済み）。
      const requestResult = await requestSignupCode({
        supabase,
        email,
        name,
        codeHash: hashKey(code),
        expiresAt,
        cooldownSeconds: SIGNUP_CODE_RESEND_COOLDOWN_SECONDS,
      });

      if (!requestResult.accepted) {
        // requestResult.retryAfterSeconds（クールダウン残り秒数）は現状フロントには返していない
        // （文言は固定メッセージのみ）。将来、残り秒数を案内したくなった場合のために保持している。
        // 【中-B対応】クールダウン中の要求（429）でもグローバル枠・メール単位の枠は消費しない。
        return res
          .status(429)
          .json({ error: '直前にコードを送信しています。1分ほど待ってから再度お試しください（メールが届かない場合は迷惑メールフォルダもご確認ください）' });
      }

      // 【L-5是正(3周目・中-B対応)】ここに到達した時点で初めて「実際にメールを送る」ことが
      // 確定する。グローバル上限（1時間300通・メール配信サービスの送信枠を守る最終防波堤）と、
      // 新設したメールアドレス単位の上限（1時間5通・独立再監査の修正案）を、ここで初めて消費する。
      // メール単位のキーは生アドレスではなくhashKey()したものを使う（メモリ上に生アドレスを
      // 長時間置かないため）。
      if (
        !requestCodeEmailLimiter(hashKey(email)) ||
        !requestCodeGlobalLimiter(REQUEST_CODE_GLOBAL_RATE_LIMIT_KEY)
      ) {
        // 送信枠の最終防波堤。ここで止まった場合は運用者が気付けるようログに残す。
        console.error('[ALERT] request-code rate limit reached at send time (email or global cap)');
        return res
          .status(429)
          .json({ error: '確認コードの送信要求が多すぎます。しばらくしてから再度お試しください' });
      }

      await sendSignupCodeEmailFn(email, code);

      res.json({ message: `${email} 宛てに確認コードを送信しました。メールをご確認ください。` });
    } catch (err) {
      console.error('request-code error:', err);
      res.status(500).json({ error: '確認コードの送信に失敗しました。しばらくしてから再度お試しください' });
    }
  });

  // 店長の自己登録 手順2：受け取った確認コードを照合し、正しければ店舗を作成する。
  // 管理者キーはこのレスポンスでしか平文を返さない（DBにはハッシュ値のみ保存）。
  // 同じメールアドレスで既に店舗を作成済みの場合、2店舗目以降は1か月間の無料配信し放題
  // 期間を付与しない（store名を変えて無料期間だけを取り続ける悪用を防ぐため）。
  app.post('/api/signup/verify-code', async (req, res) => {
    // 【L-5是正】まずIP単位のレート制限を確認する。メールアドレスを問い合わせる前に弾くことで、
    // 多数のメールアドレスを横断して広く浅く総当たりする攻撃を、DBに触れる前に止める。
    const clientIp = req.ip || (req.connection && req.connection.remoteAddress) || 'unknown';
    if (!isVerifyCodeAllowedByIp(clientIp)) {
      return res
        .status(429)
        .json({ error: '短時間に確認コードの試行が多く行われています。しばらくしてから再度お試しください' });
    }

    const email = ((req.body && req.body.email) || '').trim().toLowerCase();
    const code = ((req.body && req.body.code) || '').trim();

    if (!email || !code) {
      return res.status(400).json({ error: 'メールアドレスと確認コードを入力してください' });
    }

    try {
      // 【L-5是正(3周目・中-A対応)】存在確認・期限切れ確認・上限確認・試行枠の消費（照合の"前"に
      // 原子的にattemptsを1つ進める）・ハッシュ照合・一致時のpending行削除までを、
      // 単一のSQL関数呼び出し(RPC)で不可分に行う。これにより、同時に何件リクエストが来ても、
      // 1コードにつき照合に進める回数の合計は厳密にSIGNUP_CODE_MAX_ATTEMPTS回に制限され
      // （並行数に依存しない。AC-L5-7・AC-L5-23）、かつ「正しいコードによる検証成功」は
      // 構造的に高々1回しか起こらない（AC-L5-16）。
      // 独立再監査(SECURITY_REVIEW_L5_FINAL.md 中-A)で、以前の実装は「枠の消費」だけが
      // 原子的で「コードの使い切り」（pending行の削除）は店舗作成後の別の往復だったため、
      // 正しいコードを同時に複数本投げると全部が照合に成功してしまい、無料期間つきの店舗を
      // 複数作成できてしまうことが指摘された。SQL側で照合とDELETEまで完結させることで解消する。
      const result = await verifySignupCode({
        supabase,
        email,
        code,
        hashCode: hashKey,
        maxAttempts: SIGNUP_CODE_MAX_ATTEMPTS,
      });

      if (!result.ok) {
        // 該当なし・期限切れ・上限到達（失効）・コード不一致のいずれであっても同一の文言を返す。
        // 区別して返すと、攻撃者に「まだ正解を引いていない」等の手がかりを与えてしまうため
        // （SIGNUP_CODE_VERIFY_FAILED_MESSAGEの定義コメント参照）。
        return res.status(400).json({ error: SIGNUP_CODE_VERIFY_FAILED_MESSAGE });
      }
      const pending = result.pending;

      // 【中-A対応・重要】ここに到達した時点で、確認コードは既にconsume_signup_attempt RPCの
      // 内部で消費（pending行を削除）済みである。したがって、これ以降の店舗作成に失敗しても
      // 「pending行を明示的に削除する」処理は不要（既に無い）どころか、二重に削除しようとすると
      // 無駄なDB往復になるため行わない。一方、店舗作成が失敗した場合、利用者は同じコードで
      // やり直すことができない（コードは1回限りという設計上のトレードオフ）ため、
      // 再送を案内するエラーメッセージを別途返す。
      try {
        // 退会して同じメールアドレスで再登録した場合も無料期間を与えない（悪用防止）。
        // 判定ロジック本体は lib/signup.js に切り出している（AC-H3-3、単体テスト対象）。
        const skipFreeTrial = await resolveSkipFreeTrial({ supabase, email, hashEmail: hashKey });

        const adminKey = generateAdminKey();
        const { data: store, error } = await supabase
          .from('stores')
          .insert({
            name: pending.name,
            admin_key_hash: hashKey(adminKey),
            email,
            skip_free_trial: skipFreeTrial,
          })
          .select()
          .single();
        if (error) throw error;

        return res.status(201).json({ storeId: store.id, storeName: store.name, adminKey });
      } catch (storeErr) {
        // 確認コードの照合自体は成功し、コードは既に消費済み（再利用不可）。
        // このメッセージで「確認コードの送信からやり直せば復旧できる」ことを利用者に伝える。
        console.error('verify-code store creation error (code already consumed):', storeErr);
        return res.status(500).json({
          error:
            '確認は完了しましたが、店舗の作成に失敗しました。お手数ですが、確認コードの送信からやり直してください',
        });
      }
    } catch (err) {
      console.error('verify-code error:', err);
      res.status(500).json({ error: '店舗の作成に失敗しました' });
    }
  });

  // 管理者キー復旧 手順1：店舗登録時のメールアドレス宛てに6桁の確認コードを送る。
  // 【AC-K6・最重要】メールアドレスが実際に店舗登録済みかどうかで、応答（文言・ステータス・
  // 所要時間）が変わってはならない。これが崩れると、攻撃者がメールアドレスを次々に試すだけで
  // 「そのメールアドレスが店舗として登録されているか」を外部から判定できてしまう
  // （＝どの企業がこのサービスを契約しているかを割り出せる列挙攻撃）。
  // そのため、このハンドラは「登録済み/未登録」で分岐する処理（DB照会・メール送信）を
  // try節の中に閉じ込め、例外が起きてもログに残すだけでクライアントへの応答は変えない。
  app.post('/api/recovery/request-code', async (req, res) => {
    // IP単位のレート制限（登録の有無に関係なく、純粋にIPからの要求頻度だけで判定するため、
    // ここで429を返しても列挙のオラクルにはならない）。
    const clientIp = req.ip || (req.connection && req.connection.remoteAddress) || 'unknown';
    if (!recoveryRequestCodeIpLimiter(clientIp)) {
      return res
        .status(429)
        .json({ error: '確認コードの送信要求が多すぎます。しばらくしてから再度お試しください' });
    }

    const email = ((req.body && req.body.email) || '').trim().toLowerCase();
    if (!isValidEmail(email)) {
      // メール形式の妥当性は、店舗として登録されているかどうかとは無関係の判定のため、
      // ここで400を返してもAC-K6には抵触しない（店舗登録のrequest-codeと同じ扱い）。
      return res.status(400).json({ error: '正しいメールアドレスを入力してください' });
    }
    if (!RESEND_API_KEY) {
      return res.status(500).json({ error: 'メール認証機能が設定されていません（管理者にお問い合わせください）' });
    }

    // メール単位・グローバル単位のレート制限は、形式チェックを通過した後（＝不正なボディでは
    // 消費されない。店舗登録の独立再監査 中-B是正と同じ考え方）、かつ「登録済みかどうか」を
    // 調べる前（＝登録済み/未登録で消費有無に差が出ない。AC-K6）に行う。
    if (
      !recoveryRequestCodeEmailLimiter(hashKey(email)) ||
      !recoveryRequestCodeGlobalLimiter(RECOVERY_REQUEST_CODE_GLOBAL_RATE_LIMIT_KEY)
    ) {
      console.error('[ALERT] recovery request-code rate limit reached at send time (email or global cap)');
      return res
        .status(429)
        .json({ error: '確認コードの送信要求が多すぎます。しばらくしてから再度お試しください' });
    }

    // ここから先はDB照会のみの区間（登録済み/未登録で処理量・所要時間が変わりうる）。
    // 応答を返す直前に、この区間の所要時間を一定の下限までパディングする（AC-K6）。
    // 【中-4是正】メール送信（Resend APIへのHTTPS往復）はこの区間に含めない。padUntilは
    // あくまで「下限」であり、Resendの応答がその下限を超えると登録済み側だけが必ず遅くなり
    // タイミング差が復活してしまう（既存の下限200msちょうどのテストでは検出できない穴だった）。
    // 根本策として、メール送信は応答を返した後の非同期処理にし、送信の所要時間が
    // 応答時間に一切影響しないようにする。
    const dbPhaseStartedAt = Date.now();
    let code = null;
    let storeId = null;
    let storeName = null;
    try {
      // 6桁コードの生成ロジックは店舗登録（generateSignupCode）と共用する
      // （暗号学的乱数生成という点で用途を問わない汎用ロジックのため）。
      code = generateSignupCode();
      const expiresAt = new Date(Date.now() + KEY_RECOVERY_CODE_TTL_MINUTES * 60 * 1000).toISOString();

      const result = await requestKeyRecoveryCode({
        supabase,
        email,
        codeHash: hashKey(code),
        expiresAt,
      });
      storeId = result.storeId;
      storeName = result.storeName;
    } catch (err) {
      // 【AC-K6・重要】DB照会が失敗しても、クライアントへの応答は変えない。運用者が
      // 気づけるよう、ログにだけ詳細を残す。
      console.error('recovery request-code error (response intentionally unchanged to avoid enumeration):', err);
    }

    // 登録済み・未登録・内部エラーのいずれであっても、常にこの同一の文言・ステータス(200)を返す。
    await respondWithPadding(res, dbPhaseStartedAt, keyRecoveryRequestMinResponseTimeMs, 200, {
      message: `${email} が店舗登録済みの場合、確認コードを送信しました。メールをご確認ください（届かない場合は迷惑メールフォルダもご確認ください）。`,
    });

    // storeIdがある（＝登録済み）場合のみ実際にメールを送る。無い場合は何もしない。
    // 【中-4是正・AC-KF4】応答を返した後に送る。setImmediateで次のイベントループへ回すことで、
    // 応答の送信(res.json)が確実に処理された後にメール送信を開始する。
    if (storeId) {
      setImmediate(() => {
        sendKeyRecoveryCodeEmailFn(email, code, storeName).catch((e) => {
          // 【AC-KF5】応答は既に返却済みのため、送信に失敗しても復旧要求そのものの成否には
          // 影響しない（列挙対策の維持）。中-1と同じ「利用者には成功と表示されるのに実際は
          // メールが届かない」という沈黙した不発を運用者が把握できるよう、ログに残す。
          console.error('[ALERT] recovery request-code email send failed (response already sent):', e);
        });
      });
    }
  });

  // 管理者キー復旧 手順2：確認コードを照合し、正しければ新しい管理者キーを発行する。
  // - 【AC-K2・核心】新しいキーの発行はINSERTではなくUPDATE（stores.admin_key_hashの上書き）。
  //   これにより旧キーのハッシュは同じ1文で消え、以後requireAdminは旧キーで一致しなくなる。
  // - 【AC-K3】supervisor_keysテーブルには一切触れない。時間帯責任者キーはオーナーが
  //   管理者キーを失くしたこととは無関係に有効であり続けるべきだから。
  // - 【AC-K4】UPDATEの対象列はadmin_key_hashのみ。スタッフ(subscriptions)・募集履歴(shifts)・
  //   課金状態（subscription_status等の他の列）には一切触れない。
  app.post('/api/recovery/verify-code', async (req, res) => {
    // まずIP単位のレート制限を確認する（店舗登録のverify-codeと同じ考え方）。
    const clientIp = req.ip || (req.connection && req.connection.remoteAddress) || 'unknown';
    if (!recoveryVerifyCodeIpLimiter(clientIp)) {
      return res
        .status(429)
        .json({ error: '短時間に確認コードの試行が多く行われています。しばらくしてから再度お試しください' });
    }

    const email = ((req.body && req.body.email) || '').trim().toLowerCase();
    const code = ((req.body && req.body.code) || '').trim();
    if (!email || !code) {
      return res.status(400).json({ error: 'メールアドレスと確認コードを入力してください' });
    }

    const verifyPhaseStartedAt = Date.now();
    try {
      // 【中核】単一の原子的なSQL関数(consume_key_recovery_attempt)で、試行枠の消費・
      // 定数時間でのハッシュ照合・一致時の即時削除までを不可分に行う（consume_signup_attemptと
      // 同じ設計。AC-K5：同時に何件リクエストが来ても、1コードにつき照合に進める回数は
      // 厳密にKEY_RECOVERY_CODE_MAX_ATTEMPTS回に制限され、検証成功は構造的に高々1回しか
      // 起こらない）。
      const result = await verifyKeyRecoveryCode({
        supabase,
        email,
        code,
        hashCode: hashKey,
        maxAttempts: KEY_RECOVERY_CODE_MAX_ATTEMPTS,
      });

      if (!result.ok) {
        // 該当なし・期限切れ・上限到達（失効）・コード不一致のいずれであっても同一の文言を返す。
        return respondWithPadding(res, verifyPhaseStartedAt, keyRecoveryVerifyMinResponseTimeMs, 400, {
          error: KEY_RECOVERY_VERIFY_FAILED_MESSAGE,
        });
      }

      // ここに到達した時点で、確認コードは既にconsume_key_recovery_attempt RPCの内部で
      // 消費（該当行を削除）済み。したがって、これ以降のキー更新に失敗しても、
      // 利用者は同じコードでやり直すことができない（コードは1回限りという設計上の
      // トレードオフ。signup側のverify-codeと同じ扱い）ため、再送を案内する。
      try {
        const newAdminKey = generateAdminKey();
        const { error: updateErr } = await supabase
          .from('stores')
          .update({ admin_key_hash: hashKey(newAdminKey) })
          .eq('id', result.storeId);
        if (updateErr) throw updateErr;

        return respondWithPadding(res, verifyPhaseStartedAt, keyRecoveryVerifyMinResponseTimeMs, 200, {
          adminKey: newAdminKey,
        });
      } catch (updateErr) {
        console.error('recovery verify-code key update error (code already consumed):', updateErr);
        return respondWithPadding(res, verifyPhaseStartedAt, keyRecoveryVerifyMinResponseTimeMs, 500, {
          error:
            '確認は完了しましたが、管理者キーの更新に失敗しました。お手数ですが、確認コードの送信からやり直してください',
        });
      }
    } catch (err) {
      console.error('recovery verify-code error:', err);
      return respondWithPadding(res, verifyPhaseStartedAt, keyRecoveryVerifyMinResponseTimeMs, 500, {
        error: '管理者キーの復旧に失敗しました',
      });
    }
  });

  // 店舗名を表示用に取得する（スタッフ登録画面が、リンク先の店舗名を確認するために使う）。
  // 管理者キーなどの秘匿情報は一切含まない。
  app.get('/api/stores/:id', async (req, res) => {
    const { data, error } = await supabase.from('stores').select('id, name').eq('id', req.params.id).maybeSingle();
    if (error) {
      console.error('get store error:', error);
      return res.status(500).json({ error: '取得に失敗しました' });
    }
    if (!data) return res.status(404).json({ error: '店舗が見つかりません' });
    res.json({ id: data.id, name: data.name });
  });

  // ログイン中の店長・時間帯責任者の店舗情報を返す（管理者キーに紐づく店舗）
  app.get('/api/me', requireAdmin, (req, res) => {
    res.json({ storeId: req.storeId, storeName: req.storeName, role: req.role });
  });

  // 課金状況（無料期間・今月の残り無料回数・契約中プラン等）をダッシュボードに返す
  // 料金確認はオーナー・店長のみ
  app.get('/api/subscription-status', requireAdmin, requireOwner, async (req, res) => {
    try {
      const store = req.store;
      const now = new Date();
      const trialEnd = trialEndsAt(store);
      const inTrial = now < trialEnd;
      const subscribed = hasActiveSubscription(store);

      let broadcastsThisMonth = 0;
      let freeRemaining = null;
      if (!inTrial && !subscribed) {
        broadcastsThisMonth = await getMonthlyBroadcastCount(store.id);
        freeRemaining = Math.max(0, FREE_MONTHLY_BROADCASTS - broadcastsThisMonth);
      }

      res.json({
        inTrial,
        trialEndsAt: trialEnd.toISOString(),
        subscribed,
        subscriptionStatus: store.subscription_status,
        subscriptionPlan: store.subscription_plan,
        currentPeriodEnd: store.current_period_end,
        broadcastsThisMonth,
        freeRemaining,
        freeMonthlyBroadcasts: FREE_MONTHLY_BROADCASTS,
        stripeEnabled: !!stripe,
        plans: PLAN_LABELS,
      });
    } catch (err) {
      console.error('subscription-status error:', err);
      res.status(500).json({ error: '取得に失敗しました' });
    }
  });

  // アップグレード用のStripe Checkoutセッションを作成し、遷移先URLを返す
  // プラン変更・契約更新はオーナー・店長のみ
  app.post('/api/create-checkout-session', requireAdmin, requireOwner, async (req, res) => {
    if (!stripe) {
      return res.status(500).json({ error: '決済機能が設定されていません（管理者にお問い合わせください）' });
    }
    const plan = req.body && req.body.plan;
    const priceId = STRIPE_PRICES[plan];
    if (!priceId) {
      return res.status(400).json({ error: '不正なプランです' });
    }
    try {
      const store = req.store;
      let customerId = store.stripe_customer_id;
      if (!customerId) {
        const customer = await stripe.customers.create({
          name: store.name,
          metadata: { store_id: store.id },
        });
        customerId = customer.id;
        await supabase.from('stores').update({ stripe_customer_id: customerId }).eq('id', store.id);
      }

      const baseUrl = process.env.APP_URL || process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;
      const session = await stripe.checkout.sessions.create({
        mode: 'subscription',
        customer: customerId,
        line_items: [{ price: priceId, quantity: 1 }],
        success_url: `${baseUrl}/manager.html?checkout=success`,
        cancel_url: `${baseUrl}/manager.html?checkout=cancel`,
        metadata: { store_id: store.id },
        subscription_data: { metadata: { store_id: store.id } },
      });
      res.json({ url: session.url });
    } catch (err) {
      console.error('create-checkout-session error:', err);
      res.status(500).json({ error: '決済ページの作成に失敗しました' });
    }
  });

  // 解約・支払方法の変更用に、Stripeのカスタマーポータルへのリンクを発行する。
  // 解約処理やカード情報の更新はStripeがホストする画面で完結するため、
  // 自前でカード情報を扱う実装を持たずに安全に対応できる。オーナー・店長のみ。
  app.post('/api/create-billing-portal-session', requireAdmin, requireOwner, async (req, res) => {
    if (!stripe) {
      return res.status(500).json({ error: '決済機能が設定されていません（管理者にお問い合わせください）' });
    }
    const store = req.store;
    if (!store.stripe_customer_id) {
      return res.status(400).json({ error: 'まだ有料プランのお申込みがありません' });
    }
    try {
      const baseUrl = process.env.APP_URL || process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;
      const session = await stripe.billingPortal.sessions.create({
        customer: store.stripe_customer_id,
        return_url: `${baseUrl}/manager.html`,
      });
      res.json({ url: session.url });
    } catch (err) {
      console.error('create-billing-portal-session error:', err);
      res.status(500).json({ error: '契約管理画面の作成に失敗しました' });
    }
  });

  // 時間帯責任者用のサブ管理者キーを発行する。代理募集の配信のみ許可される限定キーで、
  // 発行できるのはオーナー・店長のみ。キーの平文はこのレスポンスでしか返さない。
  app.post('/api/supervisors', requireAdmin, requireOwner, async (req, res) => {
    const label = ((req.body && req.body.label) || '').trim();
    if (label.length > 30) {
      return res.status(400).json({ error: 'ラベルは30文字以内で入力してください' });
    }
    try {
      const key = generateAdminKey();
      const { data, error } = await supabase
        .from('supervisor_keys')
        .insert({ store_id: req.storeId, admin_key_hash: hashKey(key), label: label || null })
        .select()
        .single();
      if (error) throw error;
      res.status(201).json({ id: data.id, label: data.label, adminKey: key });
    } catch (err) {
      console.error('create supervisor error:', err);
      res.status(500).json({ error: '時間帯責任者キーの発行に失敗しました' });
    }
  });

  // 時間帯責任者キーの一覧（キー自体は返さず、ラベルと発行日のみ）。オーナー・店長のみ。
  app.get('/api/supervisors', requireAdmin, requireOwner, async (req, res) => {
    const { data, error } = await supabase
      .from('supervisor_keys')
      .select('id, label, created_at')
      .eq('store_id', req.storeId)
      .order('created_at', { ascending: false });
    if (error) {
      console.error('list supervisors error:', error);
      return res.status(500).json({ error: '取得に失敗しました' });
    }
    res.json(data || []);
  });

  // 時間帯責任者キーの失効。自分の店舗のキーしか消せない。オーナー・店長のみ。
  app.delete('/api/supervisors/:id', requireAdmin, requireOwner, async (req, res) => {
    const { error } = await supabase
      .from('supervisor_keys')
      .delete()
      .eq('id', req.params.id)
      .eq('store_id', req.storeId);
    if (error) {
      console.error('delete supervisor error:', error);
      return res.status(500).json({ error: '失効に失敗しました' });
    }
    res.json({ message: '失効しました' });
  });

  // スタッフの通知宛先(Subscription)を保存。どの店舗・誰の登録かも一緒に記録する。
  // store_idは店長から配られたリンク/QRコードのURL(?store=店舗ID)から来るため、
  // 店舗名が他店と被っていても間違った店舗に登録される心配がない。
  // 名前は仮名で構わないが、応募時のなりすまし防止のため必須にしている。
  app.post('/api/subscribe', async (req, res) => {
    const { subscription, store_id, staff_name } = req.body || {};
    const name = (staff_name || '').trim();
    if (!subscription || !subscription.endpoint) {
      return res.status(400).json({ error: '不正なリクエストです' });
    }
    if (!store_id) {
      return res.status(400).json({ error: '店舗のリンクが正しくありません' });
    }
    if (!name) {
      return res.status(400).json({ error: 'お名前（仮名でも可）を入力してください' });
    }
    if (name.length > STAFF_NAME_MAX_LENGTH) {
      return res.status(400).json({ error: `お名前は${STAFF_NAME_MAX_LENGTH}文字以内で入力してください` });
    }
    const personalInfoIssue = findPersonalInfoIssue(name);
    if (personalInfoIssue) {
      return res.status(400).json({ error: personalInfoIssue });
    }
    try {
      const { data: store, error: storeErr } = await supabase
        .from('stores')
        .select('id, name')
        .eq('id', store_id)
        .maybeSingle();
      if (storeErr) throw storeErr;
      if (!store) return res.status(400).json({ error: '店舗が見つかりません（リンクが正しいか確認してください）' });

      const { data: existing, error: selErr } = await supabase
        .from('subscriptions')
        .select('id')
        .eq('endpoint', subscription.endpoint)
        .maybeSingle();
      if (selErr) throw selErr;

      if (!existing) {
        const { error: insErr } = await supabase
          .from('subscriptions')
          .insert({ endpoint: subscription.endpoint, subscription, store_id: store.id, store_name: store.name, staff_name: name });
        if (insErr) throw insErr;
      } else {
        // 既に登録済みの端末が店舗や名前を選び直した場合は上書きする
        const { error: updErr } = await supabase
          .from('subscriptions')
          .update({ store_id: store.id, store_name: store.name, staff_name: name })
          .eq('endpoint', subscription.endpoint);
        if (updErr) throw updErr;
      }

      const { count, error: countErr } = await supabase
        .from('subscriptions')
        .select('*', { count: 'exact', head: true })
        .eq('store_id', store.id);
      if (countErr) throw countErr;

      res.status(201).json({ message: `${store.name}のスタッフ「${name}」として宛先を保存しました`, count });
    } catch (err) {
      console.error('subscribe error:', err);
      res.status(500).json({ error: '宛先の保存に失敗しました' });
    }
  });

  // スタッフ：自分の通知登録を解除する（利用規約 第17条1項「いつでも退会することができます」対応）。
  // スタッフは管理者キーを持たないため認証なしで呼べるが、削除対象は endpoint
  // （ブラウザが発行する推測不可能な識別子）で一意に特定するため、他人の登録を
  // 誤って（または悪意を持って）消せる心配はない。/api/subscribe が同じ考え方で
  // endpointをキーに upsert しているのと同様の設計。
  // shifts.filled_by に残る過去の応募履歴は勤務実績の記録として必要なため、削除・匿名化しない。
  app.delete('/api/subscribe', async (req, res) => {
    const endpoint = (req.body && req.body.endpoint) || '';
    if (!endpoint) {
      return res.status(400).json({ error: '解除対象が指定されていません' });
    }
    try {
      const { error } = await supabase.from('subscriptions').delete().eq('endpoint', endpoint);
      if (error) throw error;
      res.json({ message: '通知登録を解除しました' });
    } catch (err) {
      console.error('unsubscribe error:', err);
      res.status(500).json({ error: '解除に失敗しました' });
    }
  });

  // オーナー・店長／時間帯責任者：ヘルプ募集を自分の店舗のスタッフに配信
  // 店舗はリクエストボディからではなく、ログインに使った管理者キーから決まる。
  // これにより、ある店舗のキーでログインした人が他店舗へ誤配信することはできない。
  // 代理募集の配信は時間帯責任者にも許可されている操作のため requireOwner は付けない。
  app.post('/api/send-broadcast', requireAdmin, async (req, res) => {
    const storeId = req.storeId;
    const storeName = req.storeName;
    const { date, time, note } = req.body;
    if (!date || !time) {
      return res.status(400).json({ error: '日付・時間は必須です' });
    }

    try {
      const check = await checkBroadcastAllowed(req.store);
      if (!check.allowed) {
        return res.status(402).json({
          error: `今月の無料配信回数（${FREE_MONTHLY_BROADCASTS}回）を超えました。プランをアップグレードすると引き続きご利用いただけます。`,
          upgradeRequired: true,
        });
      }

      const { data: shift, error: insErr } = await supabase
        .from('shifts')
        .insert({ store_id: storeId, store_name: storeName, date, time, note: note || '' })
        .select()
        .single();
      if (insErr) throw insErr;

      const shiftId = shift.id;
      // APP_URLを明示指定していなければ、Renderが自動で用意するURLを使う
      const baseUrl = process.env.APP_URL || process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;
      const payload = JSON.stringify({
        title: `DAIDA+ 🚨【急募】${storeName}`,
        body: `【日時】${date} ${time}${note ? '\n' + note : ''}\n先着1名です。タップして応募！`,
        url: `${baseUrl}/respond.html?id=${shiftId}`,
      });

      // 同じ店舗を選んで登録したスタッフだけに送る（他店舗には届かない）
      const { data: subs, error: subsErr } = await supabase
        .from('subscriptions')
        .select('*')
        .eq('store_id', storeId);
      if (subsErr) throw subsErr;

      let sent = 0;
      let failed = 0;
      const staleEndpoints = [];

      await Promise.all(
        (subs || []).map(async (s) => {
          try {
            await webpush.sendNotification(s.subscription, payload);
            sent++;
          } catch (err) {
            failed++;
            if (err.statusCode === 410 || err.statusCode === 404) {
              staleEndpoints.push(s.endpoint);
            }
            console.error('送信失敗:', err.statusCode, s.endpoint);
          }
        })
      );

      if (staleEndpoints.length) {
        await supabase.from('subscriptions').delete().in('endpoint', staleEndpoints);
      }

      res.json({ message: `${sent}台に送信しました（失敗: ${failed}）`, shiftId });
    } catch (err) {
      console.error('send-broadcast error:', err);
      res.status(500).json({ error: '配信に失敗しました' });
    }
  });

  // スタッフ：募集の現在の状態を確認（respond.html用）
  // 応募時になりすましを防ぐため、その店舗に登録済みのスタッフ名一覧も一緒に返す。
  app.get('/api/shift/:id', async (req, res) => {
    const { data, error } = await supabase.from('shifts').select('*').eq('id', req.params.id).maybeSingle();
    if (error) {
      console.error('get shift error:', error);
      return res.status(500).json({ error: '取得に失敗しました' });
    }
    if (!data) return res.status(404).json({ error: '募集が見つかりません' });

    const { data: staffRows, error: staffErr } = await supabase
      .from('subscriptions')
      .select('staff_name')
      .eq('store_id', data.store_id);
    if (staffErr) {
      console.error('get staff error:', staffErr);
      return res.status(500).json({ error: '取得に失敗しました' });
    }
    const staffNames = Array.from(new Set((staffRows || []).map((r) => r.staff_name).filter(Boolean)));

    res.json({ ...mapShift(data), staffNames });
  });

  // スタッフ：先着順で応募する
  // UPDATE ... WHERE status = 'open' を使うことで、複数人が同時に応募しても
  // Postgres側で1件しか更新が成功しない（先着順が保証される）。
  // 応募前に「その店舗に登録済みの名前かどうか」を確認し、なりすまし応募を防ぐ。
  app.post('/api/shift/:id/respond', async (req, res) => {
    try {
      const name = (req.body && req.body.name ? String(req.body.name) : '').trim();
      if (!name) {
        return res.status(400).json({ error: 'お名前を選択してください' });
      }

      const { data: shift, error: shiftErr } = await supabase
        .from('shifts')
        .select('*')
        .eq('id', req.params.id)
        .maybeSingle();
      if (shiftErr) throw shiftErr;
      if (!shift) return res.status(404).json({ error: '募集が見つかりません' });

      const { data: staffRows, error: staffErr } = await supabase
        .from('subscriptions')
        .select('staff_name')
        .eq('store_id', shift.store_id)
        .eq('staff_name', name);
      if (staffErr) throw staffErr;
      if (!staffRows || !staffRows.length) {
        return res.status(403).json({ error: 'その店舗に登録されている名前を選んでください' });
      }

      const { data, error } = await supabase
        .from('shifts')
        .update({
          status: 'filled',
          filled_by: name,
          filled_at: new Date().toISOString(),
        })
        .eq('id', req.params.id)
        .eq('status', 'open')
        .select()
        .maybeSingle();
      if (error) throw error;

      if (data) {
        res.json({ message: '応募が完了しました！ありがとうございます！', shift: mapShift(data) });

        // 【AC-N5】通知メールの送信は、応答(res.json)を返した後に行う。応募は先着順で、
        // スタッフは「応募できたか」を一刻も早く知りたい場面のため、Resendへの往復を
        // 待たせて応答を遅らせてはいけない。setImmediateで次のイベントループへ回すことで、
        // 応答の送信が確実に処理された後に通知処理を開始する
        // （/api/recovery/request-codeの中-4是正と同じ対処）。
        // 【AC-N7】このブロックはUPDATEが1件成功した(＝自分が先着で確定した)場合にしか
        // 到達しない。先着で負けた場合はdataがnullになりこのifに入らないため、
        // 通知は構造的に送られない。
        setImmediate(async () => {
          try {
            // 通知先は店舗登録時に確認済みのメールアドレス(stores.email)。shiftsテーブルには
            // 店舗名(store_name)しか持たせていないため、宛先を得るためにstoresを引く。
            const { data: store, error: storeErr } = await supabase
              .from('stores')
              .select('email')
              .eq('id', data.store_id)
              .maybeSingle();
            if (storeErr) throw storeErr;

            // 【AC-N6】メール認証機能を追加する前に作られた古い店舗はstores.emailがnullの
            // ことがある。その場合は送信をスキップする（エラーにはしない）。
            if (!store || !store.email) return;

            await sendShiftFilledNotificationEmailFn({
              storeEmail: store.email,
              storeName: data.store_name,
              filledBy: data.filled_by,
              date: data.date,
              time: data.time,
              note: data.note,
            });
          } catch (e) {
            // 【AC-N3・最重要】応募の確定(UPDATE)はすでに成功しており、応答も返却済みのため、
            // ここでの失敗（宛先取得の失敗・メール送信の失敗のどちらも含む）は応募そのものの
            // 成否には一切影響しない。スタッフには「応募できた」という結果を維持したまま、
            // 運用者だけがRenderのログで気づけるよう、console.errorに記録する
            // （/api/reportで同じ判断をした前例と整合させる）。
            console.error('[ALERT] shift filled notification email failed (response already sent):', e);
          }
        });
        return;
      }

      // 更新が0件だった場合：応募している間にすでに他の人が埋めていた
      return res.status(409).json({ error: '残念、すでに他のスタッフが対応済みです', shift: mapShift(shift) });
    } catch (err) {
      console.error('respond error:', err);
      res.status(500).json({ error: '応募処理に失敗しました' });
    }
  });

  // 通報の受付（利用規約 第13条）。スタッフは管理者キーを持たないため、この
  // エンドポイントは認証なしで誰でも呼べる（店長・時間帯責任者も同じ窓口を使う）。
  // 認証なしで呼べる分、荒らしの標的になりうるため、同一IPからの短時間の大量送信を
  // レート制限する（lib/rateLimit.js）。
  // 第13条3項により「調査結果・判断理由・実施した措置の詳細を開示する義務を負わない」ため、
  // 送信者には受付完了の表示のみを返し、調査状況等は一切返さない。
  app.post('/api/report', async (req, res) => {
    const clientIp = req.ip || (req.connection && req.connection.remoteAddress) || 'unknown';
    if (!isReportRequestAllowed(clientIp)) {
      return res.status(429).json({ error: '短時間に多くの通報が送信されています。しばらくしてから再度お試しください' });
    }
    // 【M-3是正】IP単位の制限を通過した後で、サービス全体のグローバル上限も確認する。
    // IPをローテーションする攻撃者はIP単位の制限を素通りできるため、これが最後の砦になる。
    if (!isReportAllowedGlobally(REPORT_GLOBAL_RATE_LIMIT_KEY)) {
      console.error('report: global rate limit reached', new Date().toISOString());
      return res.status(503).json({ error: '現在通報の受付が混み合っています。しばらくしてから再度お試しください' });
    }

    const storeId = (req.body && req.body.store_id) || null;
    const reporter = (req.body && req.body.reporter) || '';
    const target = (req.body && req.body.target) || '';
    const content = (req.body && req.body.content) || '';

    const validationError = validateReportInput({ target, content, reporter });
    if (validationError) {
      return res.status(400).json({ error: validationError });
    }

    try {
      // store_idが指定されていても、実在する店舗でなければ紐付けない
      // （DBのFK制約に依存せず、存在しないIDでも通報自体は受け付けられるようにするため）
      let linkedStoreId = null;
      if (storeId) {
        const { data: store, error: storeErr } = await supabase.from('stores').select('id').eq('id', storeId).maybeSingle();
        if (storeErr) throw storeErr;
        if (store) linkedStoreId = store.id;
      }

      // 通報は無認証・自己申告のため、運営が虚偽通報かどうかを判断できるよう
      // 受信時のIPアドレスとUser-Agentを証跡として記録する（プライバシーポリシー
      // 第2条11〜13項・第3条8項に記載済みの取得・利用目的の範囲内）。
      const sourceIp = String(clientIp).slice(0, REPORT_SOURCE_IP_MAX_LENGTH);
      const userAgent = String(req.headers['user-agent'] || '').slice(0, REPORT_USER_AGENT_MAX_LENGTH);

      const receivedAt = new Date().toISOString();
      const { error: insErr } = await supabase.from('reports').insert({
        store_id: linkedStoreId,
        reporter: reporter.trim() || null,
        target: target.trim(),
        content: content.trim(),
        source_ip: sourceIp,
        user_agent: userAgent,
      });
      if (insErr) throw insErr;

      // 【最重要】通報の保存（上のinsert）はここまでで既に成功している。
      // 以降のメール通知が失敗しても、通報の受付自体は成功（201）として扱う。
      //
      // 理由：ここでメール失敗を理由に500を返すと、利用者には「通報できなかった」ように
      // 見えるのに、reportsテーブルには保存済みという食い違いが生まれる。利用者が
      // 「失敗した」と思って通報をやり直せば、同じ内容がDBに重複して残ってしまう。
      // 通報の受付（保存）とその通知（メール送信）は別の責務であり、通知の失敗は
      // 受付そのものを失敗として扱う理由にはならない。
      // そのため、メール送信は独立したtry/catchで囲み、失敗してもここでは何もエラーを
      // 返さず、console.errorにだけ記録する（Renderのログで運営が追跡できるようにするため。
      // 本エンドポイント自体は第13条3項により調査状況等を利用者に開示しない設計のため、
      // レスポンスにメール送信の成否を含めることもしない）。
      try {
        await sendReportNotificationEmailFn({
          receivedAt,
          target: target.trim(),
          content: content.trim(),
          reporter: reporter.trim() || null,
          storeId: linkedStoreId,
          sourceIp,
        });
      } catch (mailErr) {
        console.error('report notification email error:', mailErr);
      }

      res.status(201).json({ message: '通報を受け付けました。内容を確認いたします。' });
    } catch (err) {
      console.error('report error:', err);
      res.status(500).json({ error: '通報の送信に失敗しました' });
    }
  });

  // オーナー・店長：店舗の退会（利用規約 第17条1項「いつでも退会することができます」対応）。
  // 【最も慎重に扱うべきエンドポイント】
  // - requireOwner を必ず通す（時間帯責任者は退会できない）
  // - store_idはリクエストボディから受け取らず、認証済みのreq.storeId（管理者キーから
  //   一意に決まる）のみを使う。これにより他店舗のデータを削除することはできない。
  // - 誤操作防止のため、店舗名の入力一致を必須にする
  // - 実際の解約・削除処理の順序（Stripe解約→used_emails記録→stores削除）は
  //   lib/withdrawal.js の performStoreWithdrawal に集約している（順序を守る理由もそちらを参照）
  app.post('/api/withdraw', requireAdmin, requireOwner, async (req, res) => {
    const confirmStoreName = ((req.body && req.body.confirmStoreName) || '').trim();
    if (!confirmStoreName || confirmStoreName !== req.storeName) {
      return res.status(400).json({ error: '店舗名の入力が一致しません。正確に入力してください' });
    }

    try {
      await performStoreWithdrawal({
        supabase,
        stripe,
        storeId: req.storeId, // ← req.body由来の値は絶対に使わない
        storeEmail: req.store.email,
        stripeSubscriptionId: req.store.stripe_subscription_id,
        hashEmail: hashKey,
      });
      res.json({ message: '退会処理が完了しました。ご利用ありがとうございました。' });
    } catch (err) {
      console.error('withdraw error:', err);
      if (err instanceof WithdrawalError) {
        // 失敗した段階（stage）に応じたメッセージを組み立てる（lib/withdrawal.js参照）。
        // Stripe解約後の段階で失敗した場合は「中止した」ではなく実態に即した案内になる。
        const { status, message } = describeWithdrawalError(err, { supportEmail: SUPPORT_EMAIL });
        return res.status(status).json({ error: message });
      }
      res.status(500).json({ error: '退会処理に失敗しました' });
    }
  });

  // 店長：募集一覧（ダッシュボード用）。自分の店舗の分だけを返す。
  app.get('/api/shifts', requireAdmin, async (req, res) => {
    const { data, error } = await supabase
      .from('shifts')
      .select('*')
      .eq('store_id', req.storeId)
      .order('created_at', { ascending: false });
    if (error) {
      console.error('list shifts error:', error);
      return res.status(500).json({ error: '取得に失敗しました' });
    }
    res.json((data || []).map(mapShift));
  });

  // 店長：自分の店舗に登録済みのスタッフ一覧（誰が登録しているか確認できるように）
  // スタッフ管理はオーナー・店長のみ
  app.get('/api/staff', requireAdmin, requireOwner, async (req, res) => {
    const { data, error } = await supabase
      .from('subscriptions')
      .select('staff_name, registered_at')
      .eq('store_id', req.storeId)
      .order('registered_at', { ascending: false });
    if (error) {
      console.error('list staff error:', error);
      return res.status(500).json({ error: '取得に失敗しました' });
    }
    res.json((data || []).map((r) => ({ staffName: r.staff_name, registeredAt: r.registered_at })));
  });

  return app;
}

// 実際にサーバーを起動する処理（VAPID鍵のロード・Supabase接続・app.listen()）。
// buildApp()とは異なり副作用を伴うため、require.main === module のガード配下でのみ
// 呼び出される（下部参照。AC-L5-25）。
async function main() {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
    console.error('❌ SUPABASE_URLとSUPABASE_SERVICE_KEYを.envに設定してください（.env.example参照）。');
    process.exit(1);
  }
  defaultSupabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

  sharedVapidKeys = await loadOrCreateVapidKeys();
  webpush.setVapidDetails(
    process.env.VAPID_CONTACT_EMAIL ? `mailto:${process.env.VAPID_CONTACT_EMAIL}` : 'mailto:example@example.com',
    sharedVapidKeys.publicKey,
    sharedVapidKeys.privateKey
  );

  console.log('=========================================');
  console.log('🔑 PUBLIC VAPID KEY:', sharedVapidKeys.publicKey);
  console.log('=========================================');
  if (!stripe) {
    console.log('ℹ️ STRIPE_SECRET_KEY未設定：課金アップグレード機能は無効です（無料枠のロジックは動作します）');
  }

  const app = buildApp();
  app.listen(PORT, () => console.log(`Server running: http://localhost:${PORT}`));
}

// コンテナ起動直後は、システムクロックがまだNTP同期しきっていないことがあり、
// SupabaseのJWT検証が「JWT issued at future」（PGRST303）で一時的に失敗することがある。
// これはコード側の不具合ではなく起動タイミングの問題で、数秒待てば解消する。
// main()がapp.listen()に到達する前（＝ルート未登録の段階）でしか失敗しないため、
// 素朴にmain()を再実行しても副作用（二重登録等）は起きない。
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function startWithRetry(retriesLeft = 5) {
  try {
    await main();
  } catch (err) {
    const isClockSkew = err && err.code === 'PGRST303';
    if (isClockSkew && retriesLeft > 0) {
      console.log(`⏳ 起動直後のクロック同期待ち（JWT issued at future）。3秒後に再試行します（残り${retriesLeft}回）`);
      await sleep(3000);
      return startWithRetry(retriesLeft - 1);
    }
    console.error('起動に失敗しました:', err);
    process.exit(1);
  }
}

// 【L-5是正(独立再監査SECURITY_REVIEW_L5_FINAL2.md 中-2対応)】直接実行された場合
// （`node server.js` や `npm start`）だけ起動処理を走らせる。require.main === module は
// 「このファイルがエントリーポイントとして直接実行されたかどうか」を判定する
// Node.js標準の方法で、テストから `require('../server')` した場合はfalseになるため、
// サーバーは起動しない（AC-L5-25）。
if (require.main === module) {
  startWithRetry();
}

// テストから buildApp() を使えるようにexportする（AC-L5-26）。
// main() もexportしているが、これは将来的な用途のためで、テストは通常buildApp()のみを使う
// （main()を呼ぶと実際にSupabase接続・app.listen()が発生するため、テストからは呼ばない）。
module.exports = { main, buildApp };
