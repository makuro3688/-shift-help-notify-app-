'use strict';

// 管理者キー復旧（/api/recovery/request-code, /api/recovery/verify-code）の中核ロジック。
// server.js から実際のDB問い合わせ・応答タイミングの制御を切り出し、単体テストできるように
// している（lib/signup.js と同じ方針）。
//
// --- 背景：なぜ必要か ---
// 管理者キーはSHA-256でハッシュ化してDBに保存しており、運営側も元のキーを知らない。
// 顧客がキーを失うと、店舗にアクセスできず、スタッフ全員に登録し直してもらう必要があり、
// 有料プラン契約中なら使えないのに引き落としだけ続くという致命的な状態になる。
// この機能は、店舗登録時のメールアドレス宛てに確認コードを送って本人確認したうえで、
// 新しい管理者キーを発行する（旧キーは失効させる。時間帯責任者キーは維持する）。
//
// --- 【設計判断】店舗登録の pending_signups テーブル・RPCをそのまま使わなかった理由 ---
// 「新しい仕組みを作るより、既存のものを再利用するほうが安全」という方針を踏まえ、
// 店舗登録（lib/signup.js）が使う pending_signups / consume_signup_attempt /
// request_signup_code をそのまま流用する案を最初に検討したが、次の理由から見送り、
// 専用のテーブル（key_recovery_requests）・専用のRPCを新設した。
//
//   1. pending_signups.email には一意インデックスがあり、「1メールにつき保留行は1つ」しか
//      持てない。もし管理者キー復旧のリクエストも同じテーブル・同じ一意キーを使うと、
//      店舗登録の途中（確認コード送信直後）と管理者キー復旧の途中が同じメールアドレスで
//      重なった場合、片方の保留行がもう片方を上書きしてしまう。
//      「新規登録のつもりが、復旧の確認コードで上書きされて登録できなくなる」
//      「復旧のつもりが、新規登録の確認コードで復旧できてしまう」といった取り違えが
//      起きうる（ユーザーが同じメールアドレスで両方の画面を別タブで操作した場合など）。
//   2. pending_signups.name は「これから作る店舗の名前」を保持する列でNOT NULL制約がある。
//      復旧は「既存の店舗（store_id）」に紐付ける必要があり、意味が根本的に異なる。
//      異なる意味の列を無理に共用すると、将来どちらかの機能を変更した際に
//      もう片方を意図せず壊しやすい。
//   3. 最も重要な点として、「用途を区別する列（例: purpose）を1つのテーブルに足す」案も
//      検討したが、これはSQLの書き忘れ（WHERE purpose = 'recovery' を書き忘れる等）で
//      取り違えが再発しうる。テーブルそのものを分けておけば、「新規登録のコードで
//      復旧ができる」「復旧のコードで新規店舗が作れる」という取り違えは、
//      コードのバグに関わらず構造的に起こり得ない。
//
// 一方で、店舗登録で確立・監査済みの設計パターン（L-5是正の成果）はそのまま踏襲する。
// 「新しい仕組み」を作ったのではなく、「取り違えが起きない形で、同じ安全な設計パターンを
// もう一度適用した」という位置づけ。
//   - 確認コードの検証は、単一の原子的なSQL関数（RPC）で「試行枠の消費・定数時間での
//     ハッシュ照合・一致時の即時削除」までを不可分に行う（consume_signup_attemptと同型）。
//   - 検証失敗（該当なし・期限切れ・上限到達・コード不一致）は区別せず同一のエラー文言を返す。
//
// --- 【設計判断】メールアドレス列挙の防止（AC-K6） ---
// 「復旧」機能は原理的に、新規登録より一段強い列挙対策が要る。新規登録の確認コード送信は
// 「まだ誰も使っていないメールアドレスであること」が前提のため、応答が多少割れても
// 実害は小さい。一方、復旧の確認コード送信は「そのメールアドレスが店舗として登録済みか」を
// 判定できてしまうと、攻撃者が第三者のメールアドレスを大量に試すだけで「どの企業がこの
// サービスを契約しているか」を割り出せてしまう。そのため、request_key_recovery_code RPCは
// 意図的にクールダウンによる可視的な差（429）を作らない設計にしている（RPC本体のコメント
// 参照）。応答の文言・ステータス・所要時間を登録済み/未登録で完全に同一にする責務は、
// このファイルとserver.js側のハンドラの両方で担っている。

// 確認コードの検証失敗を許容する最大回数。店舗登録のSIGNUP_CODE_MAX_ATTEMPTSと同じ根拠
// （5回なら正規利用者の打ち間違いは許容しつつ、攻撃者に与える試行機会を最小限に絞れる）。
const KEY_RECOVERY_CODE_MAX_ATTEMPTS = 5;

// 検証失敗時に返す共通のエラー文言。該当なし・期限切れ・上限到達・コード不一致のいずれでも
// この同一文言を返す（区別すると攻撃者へのオラクルになるため。SIGNUP_CODE_VERIFY_FAILED_MESSAGE
// と同じ考え方）。
const KEY_RECOVERY_VERIFY_FAILED_MESSAGE =
  'コードが正しくないか、有効期限が切れています。もう一度、確認コードの送信からやり直してください';

// pending_signups相当の保留行を発行する（RPC: request_key_recovery_code）。
// 戻り値:
//   { storeId: null, storeName: null }        … メールアドレスが未登録（該当店舗なし）。
//                                                 呼び出し側はメール送信をスキップすること。
//   { storeId, storeName }                     … 登録済み。確認コードの保留行を発行済み。
// 【重要】このRPCはクールダウンによる拒否(429相当)を返さない。呼び出し側は、この関数の
// 戻り値（送るか送らないか）に関わらず、クライアントへの応答は常に同一にすること（AC-K6）。
async function requestKeyRecoveryCode({ supabase, email, codeHash, expiresAt }) {
  const { data, error } = await supabase.rpc('request_key_recovery_code', {
    p_email: email,
    p_code_hash: codeHash,
    p_expires_at: expiresAt,
  });
  if (error) throw error;
  const row = Array.isArray(data) ? data[0] : data;
  // 【中-1是正】RPCのRETURNS TABLEの列名は out_store_id / out_store_name（setup.sql参照）。
  // store_id / store_name のままだとON CONFLICT句の推定列名と衝突し、PL/pgSQLの実行時に
  // 42702（column reference "store_id" is ambiguous）になるため、テーブル列名と重ならない
  // 名前に変更した。呼び出し側であるここも同じ名前で受け取る必要がある。
  if (!row || !row.out_store_id) {
    return { storeId: null, storeName: null };
  }
  return { storeId: row.out_store_id, storeName: row.out_store_name };
}

// 確認コードの検証（RPC: consume_key_recovery_attempt）。consume_signup_attemptと同じ設計。
// 戻り値:
//   { ok: true, storeId }  … 検証成功。key_recovery_requestsの該当行はRPC内で削除済み
//                             （コードは1回限り）。呼び出し側はstoreIdの店舗の管理者キーを
//                             再発行してよい。
//   { ok: false }          … 検証失敗（理由は区別しない）。
async function verifyKeyRecoveryCode({ supabase, email, code, hashCode, maxAttempts = KEY_RECOVERY_CODE_MAX_ATTEMPTS }) {
  const { data, error } = await supabase.rpc('consume_key_recovery_attempt', {
    p_email: email,
    p_max: maxAttempts,
    p_code_hash: hashCode(code),
  });
  if (error) throw error;
  const row = Array.isArray(data) ? data[0] : data;
  if (!row || !row.matched) {
    return { ok: false };
  }
  return { ok: true, storeId: row.store_id };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// 【AC-K6の要】応答を返す直前まで、startedAtからの経過時間がfloorMs未満なら待つ。
// これにより、「実際にメール送信のネットワーク往復が発生したか（＝メールアドレスが
// 登録済みだったか）」による所要時間の差を、クライアントから観測できないようにする。
async function padUntil(startedAt, floorMs) {
  const elapsed = Date.now() - startedAt;
  if (elapsed < floorMs) {
    await sleep(floorMs - elapsed);
  }
}

// padUntilの呼び出しを、レスポンス送信そのものと1つの関数に閉じ込めるヘルパー。
// server.js側の各エンドポイントで「このexitパスだけpadUntilを呼び忘れる」というミスが
// 起きると、その1箇所だけ応答時間の差が漏れてAC-K6が崩れる。呼び出し側がres.json()を
// 直接書かず必ずこの関数を経由するようにすることで、パディング漏れを構造的に防ぐ。
async function respondWithPadding(res, startedAt, floorMs, status, body) {
  await padUntil(startedAt, floorMs);
  res.status(status).json(body);
}

module.exports = {
  KEY_RECOVERY_CODE_MAX_ATTEMPTS,
  KEY_RECOVERY_VERIFY_FAILED_MESSAGE,
  requestKeyRecoveryCode,
  verifyKeyRecoveryCode,
  padUntil,
  respondWithPadding,
};
