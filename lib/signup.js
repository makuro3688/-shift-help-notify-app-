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

module.exports = { shouldSkipFreeTrial, resolveSkipFreeTrial };
