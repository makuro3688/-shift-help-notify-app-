'use strict';

// 退会処理（利用規約 第17条1項）に関するロジック。
// 【最も慎重に扱うべき箇所】処理順序を絶対に変えないこと：
//   1. Stripeサブスクリプションを即時解約（cancel_at_period_endではない）
//      → 失敗したらここで中断し、DBには一切触れない
//   2. used_emails にメールのハッシュを記録（無料期間の再取得防止）
//   3. stores の行を物理削除（CASCADEでsupervisor_keys/subscriptions/shiftsも削除される）
// storesを先に削除するとstripe_subscription_idが失われ、解約する手段がなくなって
// 課金だけが永久に続いてしまうため、Stripe解約 → DB削除 の順序が極めて重要。

// Stripeの解約に失敗した場合に投げる専用エラー。呼び出し側はこれを見て
// 「DBの削除は実行されていない」と判断できる。
class WithdrawalError extends Error {
  constructor(message, cause) {
    super(message);
    this.name = 'WithdrawalError';
    this.cause = cause;
  }
}

// Stripeサブスクリプションを即時解約する。
// サブスクIDが無い／Stripeが未設定／Stripe上で見つからない／既に解約済み、の場合は
// そのまま先に進んでよい（スキップ）。それ以外のエラー（Stripe障害・認証エラー等）は
// WithdrawalErrorとして投げ、呼び出し側でDB削除を中止させる。
async function cancelStripeSubscriptionIfAny(stripe, subscriptionId) {
  if (!subscriptionId) {
    return { skipped: true, reason: 'no_subscription' };
  }
  if (!stripe) {
    // Stripe未設定環境（決済機能オフ）。有料契約自体が存在しえないため安全側にスキップする。
    return { skipped: true, reason: 'stripe_not_configured' };
  }

  let subscription;
  try {
    subscription = await stripe.subscriptions.retrieve(subscriptionId);
  } catch (err) {
    if (err && err.code === 'resource_missing') {
      // サブスクが既に存在しない（手動削除等）→ 解約の必要なし
      return { skipped: true, reason: 'not_found' };
    }
    throw new WithdrawalError('Stripeサブスクリプションの確認に失敗しました', err);
  }

  if (subscription.status === 'canceled') {
    // 既に解約済み→ 何もしなくてよい
    return { skipped: true, reason: 'already_canceled' };
  }

  try {
    await stripe.subscriptions.cancel(subscriptionId);
  } catch (err) {
    throw new WithdrawalError('Stripeサブスクリプションの解約に失敗しました', err);
  }
  return { skipped: false };
}

// 退会処理の本体。
// storeIdは呼び出し側（server.js）が認証済みのreq.storeIdのみを渡すこと。
// リクエストボディ由来の値を渡すと、他店舗のデータを削除できてしまう恐れがあるため、
// この関数の引数として明示的に storeId を要求する設計にしている。
async function performStoreWithdrawal({ supabase, stripe, storeId, storeEmail, stripeSubscriptionId, hashEmail }) {
  if (!storeId) {
    throw new WithdrawalError('storeIdが指定されていません');
  }

  // 1. Stripe解約（失敗したら例外がここで投げられ、以降のDB操作は一切行われない）
  await cancelStripeSubscriptionIfAny(stripe, stripeSubscriptionId);

  // 2. used_emails にメールのハッシュを記録する（退会後に同じメールで再登録しても
  //    無料期間を再取得できないようにするため）。emailが無い店舗（旧データ等）は記録をスキップ。
  if (storeEmail) {
    const { error: emailErr } = await supabase
      .from('used_emails')
      .upsert({ email_hash: hashEmail(storeEmail) }, { onConflict: 'email_hash' });
    if (emailErr) {
      throw new WithdrawalError('退会情報の記録に失敗しました', emailErr);
    }
  }

  // 3. stores の行を物理削除する（CASCADEでsupervisor_keys/subscriptions/shiftsも削除される）
  const { error: deleteErr } = await supabase.from('stores').delete().eq('id', storeId);
  if (deleteErr) {
    throw new WithdrawalError('店舗データの削除に失敗しました', deleteErr);
  }

  return { success: true };
}

module.exports = { performStoreWithdrawal, cancelStripeSubscriptionIfAny, WithdrawalError };
