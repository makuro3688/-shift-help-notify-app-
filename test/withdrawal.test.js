'use strict';

// H-3 / AC-H3-1, AC-H3-2, AC-H3-5: 店舗の退会処理（lib/withdrawal.js）の検証。
// 実際のSupabase/Stripeには接続できない環境のため、それぞれの外部サービスを
// 単純な「呼び出しを記録するだけの」テストダブルに差し替える。差し替えるのはあくまで
// 外部サービス（Supabase/Stripe）側であり、検証対象であるperformStoreWithdrawal /
// cancelStripeSubscriptionIfAny 自体は本物のコードをそのまま実行している。
const test = require('node:test');
const assert = require('node:assert/strict');
const { performStoreWithdrawal, WithdrawalError } = require('../lib/withdrawal');

// 呼び出し順序を記録する共有配列を使って、Stripe解約 → used_emails記録 → stores削除の
// 順序が守られているかを検証できるようにする。
function createOrderTracker() {
  return [];
}

function createFakeSupabase(order, { upsertError = null, deleteError = null } = {}) {
  const calls = { upsert: [], delete: [] };
  return {
    calls,
    from(table) {
      return {
        upsert(payload, opts) {
          order.push(`db:${table}:upsert`);
          calls.upsert.push({ table, payload, opts });
          return Promise.resolve({ error: upsertError });
        },
        delete() {
          return {
            eq(col, val) {
              order.push(`db:${table}:delete`);
              calls.delete.push({ table, col, val });
              return Promise.resolve({ error: deleteError });
            },
          };
        },
      };
    },
  };
}

function createFakeStripe(order, { subscriptionStatus = 'active', retrieveError = null, cancelError = null } = {}) {
  const calls = { retrieve: [], cancel: [] };
  return {
    calls,
    subscriptions: {
      async retrieve(id) {
        order.push('stripe:retrieve');
        calls.retrieve.push(id);
        if (retrieveError) throw retrieveError;
        return { id, status: subscriptionStatus };
      },
      async cancel(id) {
        order.push('stripe:cancel');
        calls.cancel.push(id);
        if (cancelError) throw cancelError;
        return { id, status: 'canceled' };
      },
    },
  };
}

test('正常系(AC-H3-1): Stripe即時解約 → used_emails記録 → stores削除 の順序で実行される', async () => {
  const order = createOrderTracker();
  const supabase = createFakeSupabase(order);
  const stripe = createFakeStripe(order, { subscriptionStatus: 'active' });

  const result = await performStoreWithdrawal({
    supabase,
    stripe,
    storeId: 'store-123',
    storeEmail: 'owner@example.com',
    stripeSubscriptionId: 'sub_abc',
    hashEmail: (email) => `hash(${email})`,
  });

  assert.deepStrictEqual(result, { success: true });

  // Stripe解約が最初、used_emails記録が2番目、stores削除が最後
  assert.deepStrictEqual(order, ['stripe:retrieve', 'stripe:cancel', 'db:used_emails:upsert', 'db:stores:delete']);

  // Stripeのcancelは正しいサブスクリプションIDに対して呼ばれている（cancel_at_period_endではなく即時解約）
  assert.deepStrictEqual(stripe.calls.cancel, ['sub_abc']);

  // used_emailsにはメールそのものではなくハッシュが保存される
  assert.strictEqual(supabase.calls.upsert[0].payload.email_hash, 'hash(owner@example.com)');
  assert.strictEqual('email' in supabase.calls.upsert[0].payload, false);

  // storesの削除は指定したstoreIdに対して行われる
  assert.strictEqual(supabase.calls.delete[0].val, 'store-123');
});

test('異常系(AC-H3-2): Stripe解約が失敗した場合、DB（used_emails/stores）には一切書き込まれない', async () => {
  const order = createOrderTracker();
  const supabase = createFakeSupabase(order);
  const stripe = createFakeStripe(order, {
    subscriptionStatus: 'active',
    cancelError: Object.assign(new Error('Stripe API error'), { code: 'api_error' }),
  });

  await assert.rejects(
    () =>
      performStoreWithdrawal({
        supabase,
        stripe,
        storeId: 'store-123',
        storeEmail: 'owner@example.com',
        stripeSubscriptionId: 'sub_abc',
        hashEmail: (email) => `hash(${email})`,
      }),
    WithdrawalError
  );

  // DBへの書き込みは一切行われていない（順序が守られている証拠）
  assert.strictEqual(supabase.calls.upsert.length, 0);
  assert.strictEqual(supabase.calls.delete.length, 0);
});

test('正常系: 既に解約済みのサブスクリプションはスキップしてDB処理には進む', async () => {
  const order = createOrderTracker();
  const supabase = createFakeSupabase(order);
  const stripe = createFakeStripe(order, { subscriptionStatus: 'canceled' });

  await performStoreWithdrawal({
    supabase,
    stripe,
    storeId: 'store-999',
    storeEmail: 'already-canceled@example.com',
    stripeSubscriptionId: 'sub_already_canceled',
    hashEmail: (email) => `hash(${email})`,
  });

  // cancelは呼ばれない（既に解約済みのため）が、DB処理は実行される
  assert.strictEqual(stripe.calls.cancel.length, 0);
  assert.strictEqual(supabase.calls.delete.length, 1);
});

test('AC-H3-5: 渡したstoreId以外の値は一切使われない（他店舗のデータを削除できない）', async () => {
  const order = createOrderTracker();
  const supabase = createFakeSupabase(order);
  const stripe = createFakeStripe(order, { subscriptionStatus: 'active' });

  const authenticatedStoreId = 'real-store-id'; // ルートハンドラがreq.storeIdとして渡す想定の値
  const maliciousBodyStoreId = 'other-store-id'; // リクエストボディに紛れ込ませようとした値（渡さない）

  await performStoreWithdrawal({
    supabase,
    stripe,
    storeId: authenticatedStoreId,
    storeEmail: 'owner@example.com',
    stripeSubscriptionId: 'sub_abc',
    hashEmail: (email) => `hash(${email})`,
  });

  assert.strictEqual(supabase.calls.delete[0].val, authenticatedStoreId);
  assert.notStrictEqual(supabase.calls.delete[0].val, maliciousBodyStoreId);
});

test('storeIdが指定されていない場合はWithdrawalErrorを投げ、DBには一切触れない', async () => {
  const order = createOrderTracker();
  const supabase = createFakeSupabase(order);
  const stripe = createFakeStripe(order);

  await assert.rejects(
    () =>
      performStoreWithdrawal({
        supabase,
        stripe,
        storeId: null,
        storeEmail: 'owner@example.com',
        stripeSubscriptionId: null,
        hashEmail: (email) => `hash(${email})`,
      }),
    WithdrawalError
  );
  assert.strictEqual(supabase.calls.upsert.length, 0);
  assert.strictEqual(supabase.calls.delete.length, 0);
});
