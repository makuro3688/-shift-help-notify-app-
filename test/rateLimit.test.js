'use strict';

// M-1: 通報APIは管理者キーなしで誰でも呼べるため、荒らし対策のレート制限が
// 正しく機能する（許可すべき件数までは通す／超えたら止める）ことを検証する。
const test = require('node:test');
const assert = require('node:assert/strict');
const { createRateLimiter } = require('../lib/rateLimit');

test('正常系: 上限件数までは同一キーからのリクエストを許可する', () => {
  const isAllowed = createRateLimiter(10_000, 3);
  assert.strictEqual(isAllowed('1.2.3.4'), true);
  assert.strictEqual(isAllowed('1.2.3.4'), true);
  assert.strictEqual(isAllowed('1.2.3.4'), true);
});

test('異常系: 上限件数を超えた同一キーからのリクエストは拒否する（荒らし対策）', () => {
  const isAllowed = createRateLimiter(10_000, 3);
  assert.strictEqual(isAllowed('1.2.3.4'), true);
  assert.strictEqual(isAllowed('1.2.3.4'), true);
  assert.strictEqual(isAllowed('1.2.3.4'), true);
  // 4回目は拒否される
  assert.strictEqual(isAllowed('1.2.3.4'), false);
  assert.strictEqual(isAllowed('1.2.3.4'), false);
});

test('別キー（別IP）は互いに影響しない', () => {
  const isAllowed = createRateLimiter(10_000, 1);
  assert.strictEqual(isAllowed('1.1.1.1'), true);
  assert.strictEqual(isAllowed('1.1.1.1'), false); // 同一キーは2回目で拒否
  assert.strictEqual(isAllowed('2.2.2.2'), true); // 別キーは影響を受けない
});

test('ウィンドウ経過後は再び許可される', async () => {
  const windowMs = 50;
  const isAllowed = createRateLimiter(windowMs, 1);
  assert.strictEqual(isAllowed('9.9.9.9'), true);
  assert.strictEqual(isAllowed('9.9.9.9'), false);
  await new Promise((resolve) => setTimeout(resolve, windowMs + 20));
  assert.strictEqual(isAllowed('9.9.9.9'), true);
});
