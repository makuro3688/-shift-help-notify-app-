'use strict';

// AC-H3-3: 退会した店舗と同じメールアドレスで再登録した場合、無料期間が付与されないことを検証する。
// 判定ロジック本体は server.js から lib/signup.js（shouldSkipFreeTrial / resolveSkipFreeTrial）へ
// 切り出してある（CHECK_REPORT.md「AC-H3-3」の指摘を受けての対応。判定ロジックがテストしにくい
// 形でserver.jsに埋まっていたため）。
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { shouldSkipFreeTrial, resolveSkipFreeTrial } = require('../lib/signup');
const { performStoreWithdrawal } = require('../lib/withdrawal');

// server.jsのhashKey（server.js:138付近）と同じアルゴリズム（SHA-256）。
// 退会時の記録（lib/withdrawal.js）と再登録時の照合（lib/signup.js）で同じハッシュ関数を
// 使わないと突合できないため、本テストでも本物と同じアルゴリズムを使う。
function hashKey(key) {
  return crypto.createHash('sha256').update(key).digest('hex');
}

// --- shouldSkipFreeTrial（純粋関数）の直接テスト ---

test('正常系: used_emailsに該当ハッシュが存在する場合、skip_free_trialはtrueになる', () => {
  const result = shouldSkipFreeTrial({ existingStore: null, usedEmail: { email_hash: 'abc' } });
  assert.strictEqual(result, true);
});

test('正常系: 既に同じメールで店舗が存在する場合も、skip_free_trialはtrueになる', () => {
  const result = shouldSkipFreeTrial({ existingStore: { id: 'store-1' }, usedEmail: null });
  assert.strictEqual(result, true);
});

test('異常系: stores・used_emailsのどちらにも存在しない新規メールアドレスは、skip_free_trialがfalseになる（無料期間が付与される）', () => {
  const result = shouldSkipFreeTrial({ existingStore: null, usedEmail: null });
  assert.strictEqual(result, false);
});

// --- resolveSkipFreeTrial（Supabase問い合わせを含む）のテスト ---
// server.js:508〜537の実際の問い合わせ手順（stores→used_emailsの順）を再現するフェイクSupabase。
function createFakeSupabase({ storesRow = null, usedEmailsRow = null } = {}) {
  return {
    from(table) {
      return {
        select() {
          return {
            eq() {
              const chain = {
                limit() {
                  return chain;
                },
                maybeSingle() {
                  if (table === 'stores') return Promise.resolve({ data: storesRow, error: null });
                  if (table === 'used_emails') return Promise.resolve({ data: usedEmailsRow, error: null });
                  return Promise.resolve({ data: null, error: null });
                },
              };
              return chain;
            },
          };
        },
      };
    },
  };
}

test('正常系(AC-H3-3): used_emailsに該当ハッシュが存在する場合、resolveSkipFreeTrialはtrueを返す', async () => {
  const email = 'withdrawn-owner@example.com';
  const supabase = createFakeSupabase({ storesRow: null, usedEmailsRow: { email_hash: hashKey(email) } });
  const result = await resolveSkipFreeTrial({ supabase, email, hashEmail: hashKey });
  assert.strictEqual(result, true);
});

test('異常系(AC-H3-3): stores・used_emailsのどちらにも存在しない新規メールアドレスなら、resolveSkipFreeTrialはfalseを返す（無料期間が付与される）', async () => {
  const email = 'brand-new-owner@example.com';
  const supabase = createFakeSupabase({ storesRow: null, usedEmailsRow: null });
  const result = await resolveSkipFreeTrial({ supabase, email, hashEmail: hashKey });
  assert.strictEqual(result, false);
});

// --- 受け入れ条件そのもの：「退会で記録したメールが、実際に再登録時の無料期間をブロックする」---
// performStoreWithdrawal（退会時に本物のコードでused_emailsへ書き込む）と
// resolveSkipFreeTrial（再登録時に本物のコードでused_emailsを照合する）を、
// 状態を共有する1つのフェイクSupabase上で連続実行する。
// これにより、CHECK_REPORT.mdが指摘した「退会処理の順序だけでなく、記録したメールが
// 再登録時に実際に無料期間を止めるかどうか」という一連の流れそのものを検証する。
function createStatefulFakeSupabaseAndStripe() {
  const usedEmails = new Map(); // email_hash -> row
  const stores = new Map(); // id -> row

  const supabase = {
    from(table) {
      if (table === 'used_emails') {
        return {
          upsert(payload) {
            usedEmails.set(payload.email_hash, payload);
            return Promise.resolve({ error: null });
          },
          select() {
            return {
              eq(col, val) {
                return {
                  maybeSingle() {
                    return Promise.resolve({ data: usedEmails.get(val) || null, error: null });
                  },
                };
              },
            };
          },
        };
      }
      if (table === 'stores') {
        return {
          delete() {
            return {
              eq(col, id) {
                stores.delete(id);
                return Promise.resolve({ error: null });
              },
            };
          },
          select() {
            return {
              eq(col, email) {
                return {
                  limit() {
                    return {
                      maybeSingle() {
                        const found = [...stores.values()].find((s) => s.email === email);
                        return Promise.resolve({ data: found ? { id: found.id } : null, error: null });
                      },
                    };
                  },
                };
              },
            };
          },
        };
      }
      throw new Error(`想定外のテーブルへのアクセス: ${table}`);
    },
  };

  const stripe = {
    subscriptions: {
      async retrieve() {
        return { status: 'active' };
      },
      async cancel() {
        return { status: 'canceled' };
      },
    },
  };

  return { supabase, stripe, stores };
}

test('正常系(AC-H3-3・受け入れ条件そのもの): 退会した店舗と同じメールアドレスで再登録すると、無料期間が付与されない', async () => {
  const email = 'owner-who-withdraws@example.com';
  const { supabase, stripe, stores } = createStatefulFakeSupabaseAndStripe();

  // 退会前は店舗が存在する
  stores.set('store-1', { id: 'store-1', email });

  // 1. 退会処理を実行する（本物のperformStoreWithdrawalを実行。used_emailsに記録が残る）
  await performStoreWithdrawal({
    supabase,
    stripe,
    storeId: 'store-1',
    storeEmail: email,
    stripeSubscriptionId: 'sub_1',
    hashEmail: hashKey,
  });

  // storesの行は物理削除されている（退会後は既存店舗検索でヒットしなくなる）
  assert.strictEqual(stores.has('store-1'), false);

  // 2. 同じメールアドレスで再登録した場合の判定（本物のresolveSkipFreeTrialを実行）
  const skipFreeTrial = await resolveSkipFreeTrial({ supabase, email, hashEmail: hashKey });

  // 退会時に記録したメールが再登録時に検知され、無料期間が付与されない
  assert.strictEqual(skipFreeTrial, true);
});

test('異常系(AC-H3-3・対比): 一度も退会していない新規メールアドレスなら、同じ状態下でも無料期間が付与される', async () => {
  const { supabase } = createStatefulFakeSupabaseAndStripe();
  const skipFreeTrial = await resolveSkipFreeTrial({
    supabase,
    email: 'never-registered@example.com',
    hashEmail: hashKey,
  });
  assert.strictEqual(skipFreeTrial, false);
});
