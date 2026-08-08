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

// --- L-5是正(2周目・高-1対応): read-modify-writeのレース条件を解消する ---
// 旧実装は「SELECTで現在値を読む→アプリ内で+1計算→UPDATEで絶対値を書き込む」という
// 非原子的な処理で、SELECTとUPDATEの間（＝Supabaseへのawait区間）に他リクエストが
// 割り込めた。セキュリティ監査(SECURITY_REVIEW_L5.md 高-1)のPoCで、同時200リクエストなら
// 1コードにつき最大1000回まで推測できてしまう（＝上限が並行数倍に水増しされる）ことが
// 実測された。楽観ロック(CAS)でも直らない（照合が書き込みより前に終わるため）ことも
// 監査人が検証済みのため、「照合の"前"に、単一の原子的なSQL文(RPC)で試行枠を消費する」
// 方式に変更した。

// --- L-5是正(3周目・中-A対応): 「枠の消費」と「コードの使い切り」の両方を原子化する ---
// 独立再監査(SECURITY_REVIEW_L5_FINAL.md 中-A)で、上記の2周目対応では「試行枠の消費」だけが
// 原子的で、「照合成功時にpending行を無効化する」処理はSQL側に無く、アプリ側で
// 店舗作成が終わったあとに別の往復（旧server.js:648のDELETE）として行われていたことが
// 指摘された。これでは、正しいコードを同時に複数本（試行枠の範囲内）投げると、
// 全リクエストが照合に成功してしまい、無料期間つきの店舗を複数作成できてしまう
// （stores.emailに一意制約が無く、resolveSkipFreeTrialがINSERTより前にSELECTするため）。
//
// 対策として、ハッシュ照合そのものをSQL側（consume_signup_attempt RPC）に移し、
// 「枠を消費する・照合する・一致すれば同じ関数内でpending行を削除する」までを
// 単一の原子的なSQL文/関数呼び出しに集約した。これにより、コードの使い切りが
// 構造的に1回だけになる（同時に何本投げても、行を消せる＝成功できるのは1本だけ）。
// 副産物として、RPCの戻り値からcode_hash（確認コードのハッシュ）が消えたため、
// 万一DB権限設定に漏れがあってもハッシュそのものが漏れなくなる（低-3への多層防御）。
//
// この変更により、ここ（JS側）の責務はさらに縮小し、「RPCに渡すためのハッシュ計算」と
// 「RPCが返したmatchedフラグを見るだけ」になった。ハッシュ比較そのもの（isSignupCodeMatch）は
// もうJS側では行わないため削除した（テストもSQL側の挙動を模したフェイクRPC経由で検証する）。

// pending_signupsに対する確認コードの検証を、原子的な試行枠消費・ハッシュ照合・
// 一致時のpending行削除とあわせて行う。server.js側の役割は、この結果（ok/pending）に
// 応じて店舗作成を行うことのみに限定される（pending行の後始末はRPC側で完結する）。
//
// 引数:
//   supabase: Supabaseクライアント（.rpcを呼べるもの）
//   email: 検証対象のメールアドレス
//   code: ユーザーが入力した確認コード（生の文字列）
//   hashCode: server.jsのhashKeyと同じハッシュ関数（code_hashと同じアルゴリズムを渡すこと）
//   maxAttempts: 試行回数の上限（省略時はSIGNUP_CODE_MAX_ATTEMPTS）
// 戻り値:
//   { ok: true, pending }  … 検証成功。pending行は既にRPC内で削除済み。
//                             呼び出し側は店舗を作成するだけでよい（削除は不要・二重削除禁止）。
//                             pendingにはcode_hashを含まない（id, nameのみ）。
//   { ok: false }          … 検証失敗（該当なし／期限切れ／上限到達／コード不一致のいずれか。
//                             区別しない。区別して返すと攻撃者へのオラクルになるため）。
//                             【重要な副作用】このRPCは「枠の消費」と同時に照合まで行うため、
//                             一致した場合は必ずpending行が消費（削除）される。したがって
//                             呼び出し側で検証成功後に何らかの理由で店舗作成に失敗しても、
//                             確認コードは既に使用済みであり、利用者はコードを再送してやり直す
//                             必要がある（コードを1回限りにするためのセキュリティ上正しい
//                             トレードオフ。server.js側でその旨をエラーメッセージに含めること）。
async function verifySignupCode({ supabase, email, code, hashCode, maxAttempts = SIGNUP_CODE_MAX_ATTEMPTS }) {
  // 【原子性がここでの肝】consume_signup_attempt は単一のSQL関数呼び出し（内部はUPDATE...
  // RETURNINGで枠を消費し、一致すれば同じ関数内でDELETEする）であり、Postgresの行ロックにより
  // 「存在確認・期限切れ確認・上限確認・試行回数の加算・ハッシュ照合・一致時の行削除」が
  // 不可分に実行される。同時に何件リクエストが届いても、消費に成功する回数は1コードあたり
  // 最大maxAttempts回に厳密に制限され（並行数に依存しない）、かつ「一致による成功」は
  // 構造的に高々1回しか起こり得ない（成功した瞬間に行が消え、後続は該当行を失う）。
  const { data: consumed, error } = await supabase.rpc('consume_signup_attempt', {
    p_email: email,
    p_max: maxAttempts,
    p_code_hash: hashCode(code),
  });
  if (error) throw error;
  const row = Array.isArray(consumed) ? consumed[0] : consumed;

  if (!row || !row.matched) {
    return { ok: false };
  }
  // code_hashはRPCの戻り値に含まれない（低-3への多層防御）ため、ここでも扱わない。
  return { ok: true, pending: { id: row.id, name: row.name } };
}

// --- L-5是正(2周目・中-1対応): request-codeの再送クールダウンも同じ欠陥を持つため原子化する ---
// 旧実装は「直近の送信時刻をSELECT→アプリ内で60秒経過を判定→古い行をDELETE→新しい行をINSERT」
// という複数文のread-modify-writeで、同時多発リクエストは全員がクールダウン判定をすり抜けられた
// （監査PoCで同時500件送信→429=0件、被害者に500通のメールが届くことを実証）。
// request_signup_code RPC（単一のINSERT...ON CONFLICT...DO UPDATE...WHERE文。
// supabase/setup.sqlのpending_signups.email一意インデックスが前提）で、
// 「クールダウン確認・古いコードの無効化・新しいコードの発行」を原子的に行う。
//
// 戻り値:
//   { accepted: true }                        … 新しいコードを発行できた（メール送信してよい）。
//   { accepted: false, retryAfterSeconds }     … クールダウン中。呼び出し側は429を返すこと。
async function requestSignupCode({ supabase, email, name, codeHash, expiresAt, cooldownSeconds }) {
  const { data, error } = await supabase.rpc('request_signup_code', {
    p_email: email,
    p_name: name,
    p_code_hash: codeHash,
    p_expires_at: expiresAt,
    p_cooldown_seconds: cooldownSeconds,
  });
  if (error) throw error;
  const row = Array.isArray(data) ? data[0] : data;
  if (!row) {
    // RPCが想定外に空を返した場合は、安全側（fail-closed）に倒してクールダウン中として扱う。
    return { accepted: false, retryAfterSeconds: cooldownSeconds };
  }
  return { accepted: Boolean(row.accepted), retryAfterSeconds: row.retry_after_seconds };
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
  verifySignupCode,
  requestSignupCode,
  SIGNUP_CODE_MAX_ATTEMPTS,
  SIGNUP_CODE_VERIFY_FAILED_MESSAGE,
};
