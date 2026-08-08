'use strict';

// AC-H3-3: 店舗登録（/api/signup/verify-code）時に、無料期間（skip_free_trial）を
// 付与するかどうかを判定するロジック。
//
// 判定対象は2つ：
//   1. 同じメールアドレスで既に店舗が存在する（stores テーブル）
//      → 店舗名を変えて複数登録することによる無料期間の使い回しを防ぐ
//   2. 同じメールアドレスが過去に退会している（used_emails テーブル）
//      → 退会時に stores 行は物理削除されるため、1だけでは「退会後の再登録」を検知できない。
//        used_emails は退会時にメールのハッシュだけを記録する専用テーブル（lib/withdrawal.js）。
//
// server.js から判定ロジック本体をここへ切り出すことで、Supabaseへの実際の問い合わせと
// 判定ロジックを分離し、それぞれを単体でテストできるようにしている。

// 既に取得済みのデータから、無料期間をスキップすべきか判定する（純粋関数）。
// existingStore / usedEmail は、それぞれの問い合わせ結果（該当行があればオブジェクト、
// 無ければ null/undefined）をそのまま渡す。
function shouldSkipFreeTrial({ existingStore, usedEmail }) {
  return Boolean(existingStore) || Boolean(usedEmail);
}

// --- L-5是正: 確認コードの総当たり攻撃対策 ---
// セキュリティ監査(L-5)で、/api/signup/verify-code に失敗回数のカウント・ロックアウト・
// レート制限が一切無く、6桁(100万通り)の確認コードが現実的な時間で総当たり可能と指摘された。
// 総当たりが成功すると、攻撃者は被害者のメールアドレスで店舗を作成し、オーナー権限そのものである
// 管理者キーを奪取できてしまう（唯一「実際に権限を奪われうる」低評価指摘）。
//
// 対策の中心は「コード単位の試行回数制限」。1つの確認コードにつき、間違った入力が
// SIGNUP_CODE_MAX_ATTEMPTS回に達したら、そのコードを即座に失効させる（以後は正しい
// コードを入力しても通らない）。これにより、1コードあたりの総当たり可能回数を5回に
// 制限し、6桁総当たり(100万通り)を非現実的にする。

// 確認コードの検証失敗を許容する最大回数。この回数に達すると、そのコード自体を失効させる。
// 5回程度なら正規利用者の打ち間違い（タイプミス・桁の見間違い等）を過度に妨げず、
// かつ攻撃者に与える試行機会を最小限に絞れる値としている。
const SIGNUP_CODE_MAX_ATTEMPTS = 5;

// 確認コードの検証に失敗した際に返すエラーメッセージ。
// 「コードが間違っています」と「試行回数の上限に達しました（＝失効しました）」を区別して
// 返すと、攻撃者に「まだ正解を引いていない」「あと何回で失効するか」を推測させる
// オラクルになってしまう。そのため、コード不一致・期限切れ・上限到達のいずれの場合でも
// server.js側は常にこの同一の文言を返す（テストで一貫性を検証できるよう、文言そのものを
// ここに集約しserver.jsと共有する）。
// 「もう一度コードを送信してください」の案内により、上限到達で詰まった利用者も
// 再送ボタンから登録をやり直せることが分かる。
const SIGNUP_CODE_VERIFY_FAILED_MESSAGE =
  'コードが正しくないか、有効期限が切れています。もう一度コードを送信してください';

// pending_signups の1行と入力コードから、検証結果を純粋に判定する（DBアクセスを含まない）。
// server.js側の役割は「この結果に応じてDBを更新する（attemptsを進める／行を削除する）」ことのみに
// 限定し、判定ロジック自体はここに集約することでユニットテストしやすくしている
// （前回のCHECK_REPORT.md指摘「判定ロジックがテストしにくい形でserver.jsに埋まっている」の教訓）。
//
// 引数:
//   pending: pending_signupsの該当行（該当なしならnull/undefined）
//   code: ユーザーが入力した確認コード（生の文字列）
//   hashCode: server.jsのhashKeyと同じハッシュ関数（引数に code_hash と同じアルゴリズムを渡すこと）
// 戻り値:
//   { ok: true }  … 検証成功。呼び出し側は店舗を作成し、pending行を削除してよい。
//   { ok: false, shouldLockout, nextAttempts } … 検証失敗。
//     shouldLockout=true の場合、この失敗でattemptsが上限に達したことを意味し、
//     呼び出し側はpending行そのものを失効（削除等）させなければならない
//     （＝「上限に達したのに、まだ正しいコードで通ってしまう」状態を作らないため）。
//     nextAttempts はDB更新時にセットすべき次のattempts値（該当コードが存在した場合のみ返す）。
function checkSignupCode({ pending, code, hashCode }) {
  // 該当する未確認の登録が無い（誤ったメールアドレス、あるいは既に検証済み/失効済み）。
  // 試行回数を記録する対象自体が無いため、DB更新は不要。
  if (!pending) {
    return { ok: false, shouldLockout: false };
  }

  // 有効期限切れ。こちらもDB更新（attempts加算）は不要（既に無効なコードのため）。
  if (new Date(pending.expires_at) < new Date()) {
    return { ok: false, shouldLockout: false };
  }

  if (pending.code_hash !== hashCode(code)) {
    const nextAttempts = (pending.attempts || 0) + 1;
    // この失敗でちょうど上限に達した場合は、呼び出し側にロックアウト（コード失効）を指示する。
    return { ok: false, shouldLockout: nextAttempts >= SIGNUP_CODE_MAX_ATTEMPTS, nextAttempts };
  }

  return { ok: true };
}

// Supabaseに実際に問い合わせ、無料期間をスキップすべきか判定する。
// hashEmail は server.js の hashKey（used_emailsへの記録時と同じハッシュ関数）を渡すこと。
// 記録時と照合時でハッシュ関数が異なると、退会したメールを二度と検知できなくなるため注意。
async function resolveSkipFreeTrial({ supabase, email, hashEmail }) {
  const { data: existingStore, error: existingErr } = await supabase
    .from('stores')
    .select('id')
    .eq('email', email)
    .limit(1)
    .maybeSingle();
  if (existingErr) throw existingErr;

  const { data: usedEmail, error: usedEmailErr } = await supabase
    .from('used_emails')
    .select('email_hash')
    .eq('email_hash', hashEmail(email))
    .maybeSingle();
  if (usedEmailErr) throw usedEmailErr;

  return shouldSkipFreeTrial({ existingStore, usedEmail });
}

module.exports = {
  shouldSkipFreeTrial,
  resolveSkipFreeTrial,
  checkSignupCode,
  SIGNUP_CODE_MAX_ATTEMPTS,
  SIGNUP_CODE_VERIFY_FAILED_MESSAGE,
};
