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

const app = express();
const PORT = process.env.PORT || 3000;

if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
  console.error('❌ SUPABASE_URLとSUPABASE_SERVICE_KEYを.envに設定してください（.env.example参照）。');
  process.exit(1);
}

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

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

const REQUEST_CODE_GLOBAL_RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000; // 1時間
const REQUEST_CODE_GLOBAL_RATE_LIMIT_MAX_REQUESTS = 300; // サービス全体で1時間あたり最大300通まで
const isRequestCodeAllowedGlobally = createRateLimiter(
  REQUEST_CODE_GLOBAL_RATE_LIMIT_WINDOW_MS,
  REQUEST_CODE_GLOBAL_RATE_LIMIT_MAX_REQUESTS
);
// グローバル制限は送信元に依存させないため、常に同じ固定キーで1つのカウンタを共有する。
const REQUEST_CODE_GLOBAL_RATE_LIMIT_KEY = 'global';

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
  const { count, error } = await supabase
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
  const { data, error } = await supabase.from('app_config').select('value').eq('key', key).maybeSingle();
  if (error) throw error;
  return data ? data.value : null;
}

async function setConfig(key, value) {
  const { error } = await supabase.from('app_config').upsert({ key, value });
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

async function main() {
  const vapidKeys = await loadOrCreateVapidKeys();
  webpush.setVapidDetails(
    process.env.VAPID_CONTACT_EMAIL ? `mailto:${process.env.VAPID_CONTACT_EMAIL}` : 'mailto:example@example.com',
    vapidKeys.publicKey,
    vapidKeys.privateKey
  );

  console.log('=========================================');
  console.log('🔑 PUBLIC VAPID KEY:', vapidKeys.publicKey);
  console.log('=========================================');
  if (!stripe) {
    console.log('ℹ️ STRIPE_SECRET_KEY未設定：課金アップグレード機能は無効です（無料枠のロジックは動作します）');
  }

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

  // 公開鍵を配布するエンドポイント
  app.get('/api/vapid-public-key', (req, res) => {
    res.json({ publicKey: vapidKeys.publicKey });
  });

  // 店長の自己登録 手順1：メールアドレス宛てに6桁の確認コードを送る。
  // 店舗名を変えるだけで無料期間（1か月間配信し放題）を何度も取り直す悪用を防ぐため、
  // 実際に受信できるメールアドレスの確認を店舗作成の前に必須にしている。
  app.post('/api/signup/request-code', async (req, res) => {
    // 【L-5是正(2周目・中-1)】まずIP単位・サービス全体のレート制限を確認する。
    // メールアドレスの妥当性チェックやDBアクセスより前に弾くことで、無認証で任意の
    // メールアドレス宛てにメールを送りつける「メール爆撃の踏み台」化を防ぐ。
    const clientIp = req.ip || (req.connection && req.connection.remoteAddress) || 'unknown';
    if (!isRequestCodeAllowedByIp(clientIp) || !isRequestCodeAllowedGlobally(REQUEST_CODE_GLOBAL_RATE_LIMIT_KEY)) {
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
        return res
          .status(429)
          .json({ error: '直前にコードを送信しています。1分ほど待ってから再度お試しください（メールが届かない場合は迷惑メールフォルダもご確認ください）' });
      }

      await sendSignupCodeEmail(email, code);

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
      // 【L-5是正(2周目・高-1)】存在確認・期限切れ確認・上限確認・試行枠の消費（照合の"前"に
      // 原子的にattemptsを1つ進める）を、単一のSQL文(RPC)で不可分に行う。
      // これにより、同時に何件リクエストが来ても、1コードにつき照合に進める回数の合計は
      // 厳密にSIGNUP_CODE_MAX_ATTEMPTS回に制限される（旧実装はここがread-modify-writeで、
      // 監査PoCにより並行数倍に水増しされることが実証されていた）。
      // 上限到達後は消費自体ができなくなる（RPCのWHERE句で自然に弾かれる）ため、
      // 「失効した行を明示的に削除する」処理も不要になった。
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

      await supabase.from('pending_signups').delete().eq('id', pending.id);

      res.status(201).json({ storeId: store.id, storeName: store.name, adminKey });
    } catch (err) {
      console.error('verify-code error:', err);
      res.status(500).json({ error: '店舗の作成に失敗しました' });
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
        return res.json({ message: '応募が完了しました！ありがとうございます！', shift: mapShift(data) });
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

      const { error: insErr } = await supabase.from('reports').insert({
        store_id: linkedStoreId,
        reporter: reporter.trim() || null,
        target: target.trim(),
        content: content.trim(),
        source_ip: sourceIp,
        user_agent: userAgent,
      });
      if (insErr) throw insErr;

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

startWithRetry();
