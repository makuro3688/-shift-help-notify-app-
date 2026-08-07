'use strict';

// M-1: 通報APIは管理者キーなしで誰でも呼べるため、荒らし対策のレート制限が
// 正しく機能する（許可すべき件数までは通す／超えたら止める）ことを検証する。
const test = require('node:test');
const assert = require('node:assert/strict');
const { createRateLimiter, MAX_KEY_LENGTH } = require('../lib/rateLimit');

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

// --- AC-F2: キー長の上限と、期限切れ・空エントリの掃除を検証する。 ---
// H-1: X-Forwarded-Forに長大な文字列や無数の異なる値を送りつけられることで、
// hitsByKeyのMapが際限なく増え続けてメモリを食いつぶす（OOMクラッシュ）ことを防ぐための修正。

test('正常系(AC-F2): キー長がMAX_KEY_LENGTHで切り詰められ、先頭が同じ長大な文字列は同一キーとして扱われる', () => {
  // maxRequests=1で、長い接頭辞は同じだが末尾だけ異なる2つのキーを送る。
  // 切り詰めが効いていれば、この2つは「同一キー」として扱われ、2回目は拒否される。
  const isAllowed = createRateLimiter(10_000, 1);
  const longPrefix = 'a'.repeat(MAX_KEY_LENGTH);
  assert.strictEqual(isAllowed(`${longPrefix}-tail-1`), true);
  assert.strictEqual(isAllowed(`${longPrefix}-tail-2`), false); // MAX_KEY_LENGTHより後ろの違いは無視される
});

test('異常系(AC-F2): キー長を切り詰めない場合と挙動が異なることを確認する（先頭が異なれば別キーとして扱われる）', () => {
  // 対比のため、先頭部分（MAX_KEY_LENGTH以内）が異なる2つのキーは、
  // 切り詰め後も別キーのままであり、互いに制限へ影響しないことを確認する。
  const isAllowed = createRateLimiter(10_000, 1);
  assert.strictEqual(isAllowed('x'.repeat(MAX_KEY_LENGTH)), true);
  assert.strictEqual(isAllowed('y'.repeat(MAX_KEY_LENGTH)), true); // 先頭から異なるので別キー扱い
});

test('正常系(AC-F2): 期限切れになったエントリはsweepExpiredEntries()でMapから掃除される', async () => {
  const windowMs = 30;
  const isAllowed = createRateLimiter(windowMs, 5);
  isAllowed('1.1.1.1');
  isAllowed('2.2.2.2');
  isAllowed('3.3.3.3');
  assert.strictEqual(isAllowed.getTrackedKeyCount(), 3);

  await new Promise((resolve) => setTimeout(resolve, windowMs + 20));
  isAllowed.sweepExpiredEntries();

  // ウィンドウを過ぎたリクエストしか持たないキーは全て削除され、Mapは空になる
  assert.strictEqual(isAllowed.getTrackedKeyCount(), 0);
});

test('異常系(AC-F2): 追跡するキー数が上限(maxTrackedKeys)を超えて無制限に増え続けない（メモリ枯渇攻撃への対策）', () => {
  // 本番のデフォルト(10000)は時間がかかるため、テストでは小さい上限を明示的に指定する。
  const maxTrackedKeys = 5;
  const isAllowed = createRateLimiter(10_000, 100, maxTrackedKeys);

  // 攻撃者が無認証APIに対して、毎回異なるキー（例: 偽装したX-Forwarded-For）で
  // 20回リクエストを送りつけたことを模擬する。
  for (let i = 0; i < 20; i++) {
    isAllowed(`attacker-key-${i}`);
  }

  // 追跡中のキー数は上限を超えて際限なく増え続けない
  assert.ok(isAllowed.getTrackedKeyCount() <= maxTrackedKeys + 1);
});
