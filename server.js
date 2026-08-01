require('dotenv').config();
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const cors = require('cors');
const webpush = require('web-push');
const { createClient } = require('@supabase/supabase-js');
const Stripe = require('stripe');

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

const FREE_TRIAL_MONTHS = 1;
const FREE_MONTHLY_BROADCASTS = 2;
const STORE_NAME_MAX_LENGTH = 50;
const STAFF_NAME_MAX_LENGTH = 20;


function trialEndsAt(store) {
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

async function getMonthlyBroadcastCount(storeId) {
  const now = new Date();
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
  const { count, error } = await supabase
    .from('shifts')
    .select('*', { count: 'exact', head: true })
    .eq('store_id', storeId)
    .gte('created_at', startOfMonth);
  if (error) throw error;
  return count || 0;
}

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

function generateAdminKey() {
  return crypto.randomBytes(20).toString('hex');
}
function hashKey(key) {
  return crypto.createHash('sha256').update(key).digest('hex');
}

function findPersonalInfoIssue(value) {
  const v = String(value || '');

  const digitCount = (v.match(/\d/g) || []).length;
  if (digitCount >= 4) {
    return '電話番号や生年月日など、数字を含む個人情報は入力しないでください';
  }

  if (/[^\s@]+@[^\s@]+\.[^\s@]+/.test(v)) {
    return 'メールアドレスは入力しないでください';
  }

  if (/(男性|女性|male|female)/i.test(v)) {
    return '性別などの個人情報は入力しないでください';
  }

  return null;
}

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

  app.use(cors());

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
      const { error: dupCheckErr } = await supabase.from('stripe_events').insert({ id: event.id });
      if (dupCheckErr && dupCheckErr.code === '23505') {
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

  async function requireAdmin(req, res, next) {
    const key = req.headers['x-admin-key'];
    if (!key) {
      return res.status(401).json({ error: '認証エラー：管理者キーが違います' });
    }
    try {
      const { data: store, error } = await supabase
        .from('stores')
        .select(
          'id, name, created_at, subscription_status, subscription_plan, stripe_customer_id, stripe_subscription_id, current_period_end'
        )
        .eq('admin_key_hash', hashKey(key))
        .maybeSingle();
      if (error) throw error;
      if (!store) {
        return res.status(401).json({ error: '認証エラー：管理者キーが違います' });
      }
      req.storeId = store.id;
      req.storeName = store.name;
      req.store = store;
      next();
    } catch (err) {
      console.error('auth error:', err);
      res.status(500).json({ error: '認証に失敗しました' });
    }
  }

  app.get('/health', (req, res) => {
    res.status(200).send('ok');
  });

  app.get('/api/vapid-public-key', (req, res) => {
    res.json({ publicKey: vapidKeys.publicKey });
  });

  app.post('/api/stores', async (req, res) => {
    const name = ((req.body && req.body.name) || '').trim();
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
    try {
      const adminKey = generateAdminKey();
      const { data: store, error } = await supabase
        .from('stores')
        .insert({ name, admin_key_hash: hashKey(adminKey) })
        .select()
        .single();
      if (error) throw error;

      res.status(201).json({ storeId: store.id, storeName: store.name, adminKey });
    } catch (err) {
      console.error('create store error:', err);
      res.status(500).json({ error: '店舗の作成に失敗しました' });
    }
  });

  app.get('/api/stores/:id', async (req, res) => {
    const { data, error } = await supabase.from('stores').select('id, name').eq('id', req.params.id).maybeSingle();
    if (error) {
      console.error('get store error:', error);
      return res.status(500).json({ error: '取得に失敗しました' });
    }
    if (!data) return res.status(404).json({ error: '店舗が見つかりません' });
    res.json({ id: data.id, name: data.name });
  });

  app.get('/api/me', requireAdmin, (req, res) => {
    res.json({ storeId: req.storeId, storeName: req.storeName });
  });

  app.get('/api/subscription-status', requireAdmin, async (req, res) => {
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

  app.post('/api/create-checkout-session', requireAdmin, async (req, res) => {
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
      const baseUrl = process.env.APP_URL || process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;
      const payload = JSON.stringify({
        title: `DAIDA+ 🚨【急募】${storeName}`,
        body: `【日時】${date} ${time}${note ? '\n' + note : ''}\n先着1名です。タップして応募！`,
        url: `${baseUrl}/respond.html?id=${shiftId}`,
      });

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

      return res.status(409).json({ error: '残念、すでに他のスタッフが対応済みです', shift: mapShift(shift) });
    } catch (err) {
      console.error('respond error:', err);
      res.status(500).json({ error: '応募処理に失敗しました' });
    }
  });

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

  app.get('/api/staff', requireAdmin, async (req, res) => {
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
