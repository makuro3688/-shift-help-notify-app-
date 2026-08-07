'use strict';

// M-1 / AC-3: 通報内容のバリデーション（送信内容の受付可否）を検証する。
const test = require('node:test');
const assert = require('node:assert/strict');
const { validateReportInput, REPORT_TARGET_MAX_LENGTH, REPORT_CONTENT_MAX_LENGTH } = require('../lib/reports');

test('正常系: 対象・内容が入力されていれば受け付ける（エラーなし）', () => {
  const error = validateReportInput({ target: '〇〇さんの投稿について', content: '不適切な発言がありました', reporter: 'やまだ' });
  assert.strictEqual(error, null);
});

test('異常系: 通報対象が空の場合はエラーになる', () => {
  const error = validateReportInput({ target: '', content: '内容です', reporter: '' });
  assert.strictEqual(error, '通報対象を入力してください');
});

test('異常系: 通報内容が空の場合はエラーになる', () => {
  const error = validateReportInput({ target: '対象です', content: '   ', reporter: '' });
  assert.strictEqual(error, '通報内容を入力してください');
});

test('異常系: 文字数上限を超えるとエラーになる', () => {
  const tooLongTarget = 'あ'.repeat(REPORT_TARGET_MAX_LENGTH + 1);
  const errorForTarget = validateReportInput({ target: tooLongTarget, content: '内容', reporter: '' });
  assert.match(errorForTarget, /通報対象は.*文字以内/);

  const tooLongContent = 'あ'.repeat(REPORT_CONTENT_MAX_LENGTH + 1);
  const errorForContent = validateReportInput({ target: '対象', content: tooLongContent, reporter: '' });
  assert.match(errorForContent, /通報内容は.*文字以内/);
});
