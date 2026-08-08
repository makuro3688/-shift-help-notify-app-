'use strict';

// 退会処理（利用規約 第17条1項）に関するロジック。
// 【最も慎重に扱うべき箇所】処理順序を絶対に変えないこと：
//   1. Stripeサブスクリプションを即時解約（cancel_at_period_endではない）
//      → 失敗したらここで中断し、DBには一切触れない
//   2. used_emails にメールのハッシュを記録（無料期間の再取得防止）
//   3. stores の行を物理削除（CASCADEでsupervisor_keys/subscriptions/shiftsも削除される）
// storesを先に削除するとstripe_subscription_idが失われ、解約する手段がなくなって
// 課金だけが永久に続いてしまうため、Stripe解約 → DB削除 の順序が極めて重要。

// 退会処理は「1.Stripe解約 → 2.used_emails記録 → 3.stores削除」の3段階からなり、
// どの段階で失敗したかによって、実際にStripeの解約が完了しているかどうかが変わる。
// 呼び出し側（server.js）がユーザーに正しい状態を案内できるよう、失敗した段階を
// stageプロパティで区別できるようにする。
//   'stripe'      : Stripe解約自体が失敗。DBには一切触れていない（安全に再試行できる）。
//   'used_emails' : Stripe解約は成功済み。used_emailsへの記録にだけ失敗した。
//   'delete'      : Stripe解約は成功済み。storesの削除にだけ失敗した。
//   'unknown'     : stageの指定漏れ（安全側フォールバック）。Stripe解約が完了しているかどうかを
//                   断定できないため、失敗・成功のどちらとも言わない案内にする（L-7）。
const WITHDRAWAL_STAGES = Object.freeze({
  STRIPE: 'stripe',
  USED_EMAILS: 'used_emails',
  DELETE: 'delete',
  UNKNOWN: 'unknown',
});

class WithdrawalError extends Error {
  // 【L-7是正】stageの既定値を'stripe'（＝解約失敗・DB未変更）に固定していると、
  // 将来Stripe解約より後段に新しいthrow new WithdrawalError(...)が追加され、
  // stage指定を忘れた場合に「実際はStripe解約済みなのに『中止しました』と誤案内する」
  // というM-1と全く同じ問題が既定値経由で静かに復活してしまう。
  // そのため既定値は「不明」側（WITHDRAWAL_STAGES.UNKNOWN）に倒し、
  // describeWithdrawalErrorでは成否を断定しない案内を返す。
  // Stripe未実行の段階で投げる例外（storeId未指定など）は、呼び出し側で
  // 明示的にWITHDRAWAL_STAGES.STRIPEを渡すこと。
  constructor(message, cause, stage) {
    super(message);
    this.name = 'WithdrawalError';
    this.cause = cause;
    this.stage = stage || WITHDRAWAL_STAGES.UNKNOWN;
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
    throw new WithdrawalError('Stripeサブスクリプションの確認に失敗しました', err, WITHDRAWAL_STAGES.STRIPE);
  }

  if (subscription.status === 'canceled') {
    // 既に解約済み→ 何もしなくてよい
    return { skipped: true, reason: 'already_canceled' };
  }

  try {
    await stripe.subscriptions.cancel(subscriptionId);
  } catch (err) {
    throw new WithdrawalError('Stripeサブスクリプションの解約に失敗しました', err, WITHDRAWAL_STAGES.STRIPE);
  }
  return { skipped: false };
}

// 退会処理の本体。
// storeIdは呼び出し側（server.js）が認証済みのreq.storeIdのみを渡すこと。
// リクエストボディ由来の値を渡すと、他店舗のデータを削除できてしまう恐れがあるため、
// この関数の引数として明示的に storeId を要求する設計にしている。
async function performStoreWithdrawal({ supabase, stripe, storeId, storeEmail, stripeSubscriptionId, hashEmail }) {
  if (!storeId) {
    // この段階ではStripe解約すら行っていないため、stageは明示的に'stripe'を渡す
    // （L-7でWithdrawalErrorの既定値を'unknown'にしたため、ここは明示が必須）。
    throw new WithdrawalError('storeIdが指定されていません', undefined, WITHDRAWAL_STAGES.STRIPE);
  }

  // 1. Stripe解約（失敗したら例外がここで投げられ、以降のDB操作は一切行われない）
  await cancelStripeSubscriptionIfAny(stripe, stripeSubscriptionId);

  // 2. used_emails にメールのハッシュを記録する（退会後に同じメールで再登録しても
  //    無料期間を再取得できないようにするため）。emailが無い店舗（旧データ等）は記録をスキップ。
  // 【L-8是正】この時点でStripeの解約は既に成功済みである。Supabaseが{error}を返す
  // ケースだけでなく、クライアント自体が例外を投げるケース（ネットワーク切断・DNS失敗等）も
  // まとめてWithdrawalErrorに変換し、呼び出し側が「解約済み」であることを案内できるようにする。
  if (storeEmail) {
    try {
      const { error: emailErr } = await supabase
        .from('used_emails')
        .upsert({ email_hash: hashEmail(storeEmail) }, { onConflict: 'email_hash' });
      if (emailErr) {
        throw new WithdrawalError('退会情報の記録に失敗しました', emailErr, WITHDRAWAL_STAGES.USED_EMAILS);
      }
    } catch (err) {
      if (err instanceof WithdrawalError) throw err;
      // Supabaseクライアントが{error}を返さず例外を投げた場合。Stripe解約が
      // 既に完了している事実は変わらないため、stageはUSED_EMAILSのまま扱う。
      throw new WithdrawalError('退会情報の記録中に予期しないエラーが発生しました', err, WITHDRAWAL_STAGES.USED_EMAILS);
    }
  }

  // 3. stores の行を物理削除する（CASCADEでsupervisor_keys/subscriptions/shiftsも削除される）
  // ここも同様にStripeの解約は既に成功済みのため、想定外の例外もWithdrawalErrorに包み直す。
  try {
    const { error: deleteErr } = await supabase.from('stores').delete().eq('id', storeId);
    if (deleteErr) {
      throw new WithdrawalError('店舗データの削除に失敗しました', deleteErr, WITHDRAWAL_STAGES.DELETE);
    }
  } catch (err) {
    if (err instanceof WithdrawalError) throw err;
    throw new WithdrawalError('店舗データの削除中に予期しないエラーが発生しました', err, WITHDRAWAL_STAGES.DELETE);
  }

  return { success: true };
}

// Stripe解約に失敗した場合のHTTPステータス。DBは一切変更されていないため、
// クライアントは安全に再試行できる（Bad Gateway相当：外部サービス連携の失敗）。
const STRIPE_STAGE_HTTP_STATUS = 502;
// Stripe解約後の段階（used_emails記録／stores削除）で失敗した場合のHTTPステータス。
// サーバー側の処理が不完全な状態で終わっているため、単純な再試行案内ではなく
// サポート窓口への連絡を促す。
const POST_STRIPE_STAGE_HTTP_STATUS = 500;
// 【L-7】stageが不明（安全側フォールバック）だった場合のHTTPステータス。
// サーバー側の状態が確認できていないため、こちらもサポート窓口への連絡を促す。
const UNKNOWN_STAGE_HTTP_STATUS = 500;

// WithdrawalErrorから、クライアントに返すべきHTTPステータスとメッセージを組み立てる。
// M-1: WithdrawalErrorはstageによって「Stripe解約自体が失敗（DB未変更）」と
// 「Stripe解約は成功済みだがDB操作が失敗（有料機能は既に止まっている）」の
// 全く異なる状態を表すため、同じ文言を返してはならない。
// server.js側の分岐ロジックをここに切り出すことで、実際に返る文言をテストで直接検証できるようにしている。
function describeWithdrawalError(err, { supportEmail }) {
  if (err.stage === WITHDRAWAL_STAGES.STRIPE) {
    return {
      status: STRIPE_STAGE_HTTP_STATUS,
      message: '解約処理に失敗したため、退会処理を中止しました。しばらくしてから再度お試しいただくか、運営にお問い合わせください',
    };
  }
  if (err.stage === WITHDRAWAL_STAGES.USED_EMAILS || err.stage === WITHDRAWAL_STAGES.DELETE) {
    // stage が 'used_emails' / 'delete' の場合、Stripeのサブスクリプション解約は既に完了している。
    // 「中止した」と案内すると店長に「何も起きていない」と誤解させてしまうため、実態に即した案内を返す。
    return {
      status: POST_STRIPE_STAGE_HTTP_STATUS,
      message: `サブスクリプションは解約されましたが、データの削除に失敗しました。お手数ですが ${supportEmail} までご連絡ください`,
    };
  }
  // 【L-7】stage が 'unknown'（未指定の安全側フォールバック）の場合。
  // Stripe解約が完了しているかどうかをこちら側で断定できないため、
  // 「失敗した」「解約された」のどちらの言い切りもせず、状況確認をサポート窓口に委ねる。
  return {
    status: UNKNOWN_STAGE_HTTP_STATUS,
    message: `退会処理の状態を確認できませんでした。解約が完了しているかどうかを確認いたしますので、お手数ですが ${supportEmail} までご連絡ください`,
  };
}

module.exports = {
  performStoreWithdrawal,
  cancelStripeSubscriptionIfAny,
  WithdrawalError,
  WITHDRAWAL_STAGES,
  describeWithdrawalError,
};
