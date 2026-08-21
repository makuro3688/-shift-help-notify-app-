'use strict';

// 時間帯責任者の通知先メールアドレス登録（/api/me/email/*）の中核ロジック。
// server.js から DB 問い合わせを切り出し、単体テストできるようにしている
// （lib/signup.js・lib/keyRecovery.js と同じ方針）。
//
// --- 背景：なぜ必要か ---
// 代打が確定したときの通知先は stores.email（オーナー）1つだけだった。
// しかし実際に代理募集を送るのは時間帯責任者であることが多く、その人に結果が
// 届かないと「自分が送った募集の結果を、自分で確認できない」状態になる。
// これは本機能の目的（アプリを何度も開かなくて済むようにする）を、
// 最も必要としている人にだけ届けていない、ということになる。
//
// --- 【設計判断】なぜ確認コードで検証するのか ---
// 確定通知メールには、応募したスタッフの氏名・店舗名・勤務日時が含まれる。
// これは第三者（スタッフ本人）の個人情報である。時間帯責任者がアドレスを
// 打ち間違えたまま登録すると、無関係の人にスタッフの個人情報が届き続け、
// しかもスタッフ本人はそれに気づくことも止めることもできない。
// 「ミスをした本人ではなく、何も知らない第三者が不利益を受ける」構造のため、
// 本人の注意力に委ねず仕組みの側で防ぐ。
//
// --- 【設計判断】列挙対策(padUntil)を入れていない理由 ---
// lib/keyRecovery.js は「そのメールアドレスが登録済みか」を応答時間から
// 推測されないよう、応答時間を一定にそろえる処理(padUntil)を持っている。
// 本ファイルには不要。理由は、このAPIが管理者キーによる認証済みであり、
// かつ対象が「自分自身の行」に固定されているため、応答から読み取れる情報が
// 「自分の状態」しか無いから。攻撃者にとって新しい情報が一切得られない。
//
// --- 【設計判断】なぜ専用テーブルを作らず supervisor_keys に列を足したか ---
// pending_signups / key_recovery_requests を別テーブルに分けた理由は
// 「同じメールアドレスをキーに別用途の保留行がぶつかり、取り違えが起きうるから」
// だった。今回は保留行の持ち主が supervisor_keys.id で一意に決まり、他の用途と
// キーを共有しない。「1人につき保留中のアドレス変更は最大1件」は制約ではなく
// むしろ望ましい仕様である。取り違えの余地が構造的に無いため、テーブルを
// 増やす理由がない（詳細は supabase/setup.sql の該当ブロックのコメント）。

// 確認コードの検証を許容する最大回数。SIGNUP_CODE_MAX_ATTEMPTS・
// KEY_RECOVERY_CODE_MAX_ATTEMPTS と同じ根拠・同じ値でそろえる。
const SUPERVISOR_EMAIL_CODE_MAX_ATTEMPTS = 5;

// 確認コードの有効期限（分）。店舗登録・キー復旧と同じ10分。
const SUPERVISOR_EMAIL_CODE_TTL_MINUTES = 10;

// 検証失敗時に返す共通のエラー文言。該当なし・期限切れ・上限到達・コード不一致の
// いずれでもこの同一文言を返す（区別すると攻撃者へのオラクルになる。
// SIGNUP_CODE_VERIFY_FAILED_MESSAGE と同じ考え方）。
const SUPERVISOR_EMAIL_VERIFY_FAILED_MESSAGE =
  'コードが正しくないか、有効期限が切れています。もう一度、確認コードの送信からやり直してください';

// メールアドレスの形式チェック。
// 【方針】RFC5322を完全に実装しようとしない。厳密な正規表現は長大なうえ、
// 正当なアドレスを弾く事故のほうが多い。ここでの目的は「明らかな入力ミスを
// その場で気づかせる」ことであり、本当の検証は確認コードが届くかどうかで行う。
// 【重要】この関数を通ることは「安全な文字列である」ことを意味しない。
// メール本文やHTMLに埋め込む際は、別途エスケープすること。
const EMAIL_MAX_LENGTH = 254; // RFC5321のアドレス長上限
function findEmailIssue(value) {
  const v = String(value || '').trim();
  if (!v) return 'メールアドレスを入力してください';
  if (v.length > EMAIL_MAX_LENGTH) return 'メールアドレスが長すぎます';
  // 空白（改行・タブを含む）が入っていたら弾く。ヘッダインジェクション対策の
  // 多層防御でもある（Resendへは JSON で渡すため本質的な穴ではないが、
  // 「宛先に改行が入りうる」状態を通さないこと自体に意味がある）。
  if (/\s/.test(v)) return 'メールアドレスに空白や改行を含めないでください';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) return 'メールアドレスの形式が正しくありません';
  return null;
}

// 確認コードの保留行を発行する（supervisor_keys の該当行を更新する）。
// 【重要】supervisorId は必ず requireAdmin が管理者キーから導出した値を渡すこと。
// リクエストボディ由来の値を渡すと、他人の通知先を書き換えられる。
async function requestSupervisorEmailCode({ supabase, supervisorId, email, codeHash, expiresAt }) {
  const { error } = await supabase
    .from('supervisor_keys')
    .update({
      pending_email: email,
      pending_email_code_hash: codeHash,
      pending_email_expires_at: expiresAt,
      // 【重要】試行回数を0に戻す。戻さないと、前回5回失敗した人が
      // 新しいコードを要求しても即座に上限扱いになり、二度と登録できなくなる。
      pending_email_attempts: 0,
    })
    .eq('id', supervisorId);
  if (error) throw error;
}

// 確認コードを検証し、一致した場合のみ pending_email を email に昇格させる
// （RPC: consume_supervisor_email_code）。
// 戻り値:
//   { ok: true, email }  … 検証成功。保留状態はRPC内で消去済み（コードは1回限り）。
//   { ok: false }        … 検証失敗（理由は区別しない）。
async function verifySupervisorEmailCode({
  supabase,
  supervisorId,
  code,
  hashCode,
  maxAttempts = SUPERVISOR_EMAIL_CODE_MAX_ATTEMPTS,
}) {
  const { data, error } = await supabase.rpc('consume_supervisor_email_code', {
    p_supervisor_id: supervisorId,
    p_max: maxAttempts,
    p_code_hash: hashCode(code),
  });
  if (error) throw error;
  const row = Array.isArray(data) ? data[0] : data;
  // 【L-013】RPCのRETURNS TABLEの列名は out_email / out_matched（setup.sql参照）。
  // supervisor_keys に email 列があるため、OUTパラメータをemailという名前にすると
  // PL/pgSQLの実行時に42702（ambiguous）を踏む危険がある。過去2回この種類の
  // エラーでリリースが止まっているため、呼び出し側もこの名前で受け取る。
  if (!row || !row.out_matched) {
    return { ok: false };
  }
  return { ok: true, email: row.out_email };
}

// 通知先の登録を解除する（確定アドレスと保留状態の両方を消す）。
// 保留状態も一緒に消すのが要点。確定アドレスだけ消すと、
// 「解除したのに、前に要求したコードを入れれば復活する」ことになる。
async function clearSupervisorEmail({ supabase, supervisorId }) {
  const { error } = await supabase
    .from('supervisor_keys')
    .update({
      email: null,
      pending_email: null,
      pending_email_code_hash: null,
      pending_email_expires_at: null,
      pending_email_attempts: 0,
    })
    .eq('id', supervisorId);
  if (error) throw error;
}

module.exports = {
  SUPERVISOR_EMAIL_CODE_MAX_ATTEMPTS,
  SUPERVISOR_EMAIL_CODE_TTL_MINUTES,
  SUPERVISOR_EMAIL_VERIFY_FAILED_MESSAGE,
  EMAIL_MAX_LENGTH,
  findEmailIssue,
  requestSupervisorEmailCode,
  verifySupervisorEmailCode,
  clearSupervisorEmail,
};
