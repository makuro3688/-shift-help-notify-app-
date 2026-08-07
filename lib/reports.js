'use strict';

// 通報内容の文字数上限（マジックナンバー回避のため定数化）
const REPORT_TARGET_MAX_LENGTH = 100;
const REPORT_CONTENT_MAX_LENGTH = 1000;
const REPORT_REPORTER_MAX_LENGTH = 50;

// 通報内容のバリデーション。問題があればエラーメッセージ文字列を、問題なければnullを返す。
// 利用規約 第13条に基づく通報機能のうち、送信内容のチェックを担う純粋関数。
// server.js側のルートハンドラでも、クライアント側（各HTML）と同じ内容を検証している
// （クライアント側だけの制限は回避可能なため、必ずサーバー側でも検証する）。
function validateReportInput({ target, content, reporter }) {
  const t = String(target || '').trim();
  const c = String(content || '').trim();
  const r = String(reporter || '').trim();

  if (!t) return '通報対象を入力してください';
  if (!c) return '通報内容を入力してください';
  if (t.length > REPORT_TARGET_MAX_LENGTH) return `通報対象は${REPORT_TARGET_MAX_LENGTH}文字以内で入力してください`;
  if (c.length > REPORT_CONTENT_MAX_LENGTH) return `通報内容は${REPORT_CONTENT_MAX_LENGTH}文字以内で入力してください`;
  if (r.length > REPORT_REPORTER_MAX_LENGTH) return `通報者情報は${REPORT_REPORTER_MAX_LENGTH}文字以内で入力してください`;
  return null;
}

module.exports = {
  validateReportInput,
  REPORT_TARGET_MAX_LENGTH,
  REPORT_CONTENT_MAX_LENGTH,
  REPORT_REPORTER_MAX_LENGTH,
};
