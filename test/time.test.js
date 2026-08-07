'use strict';

// L-2 / AC-5: 月次カウントの起点を日本時間(JST)基準で計算できているかを検証する。
// 「日本時間8/1 0:01の配信が8月分としてカウントされる」ことを保証するのが目的。
const test = require('node:test');
const assert = require('node:assert/strict');
const { getJSTMonthStartISO } = require('../lib/time');

test('正常系: JST 2026-08-01 00:01 を基準にすると、月初はJST 2026-08-01 00:00（=UTC 2026-07-31T15:00:00.000Z）になる', () => {
  // JST 2026-08-01 00:01 = UTC 2026-07-31T15:01:00.000Z
  const nowJustAfterMidnightJST = new Date('2026-07-31T15:01:00.000Z');
  const startOfMonth = getJSTMonthStartISO(nowJustAfterMidnightJST);
  assert.strictEqual(startOfMonth, '2026-07-31T15:00:00.000Z');

  // 配信時刻(now)は月初以降でなければならない（＝8月分としてカウントされる）
  assert.ok(new Date(nowJustAfterMidnightJST).getTime() >= new Date(startOfMonth).getTime());
});

test('異常系: UTCをローカル時刻とするサーバー（Render等）での旧実装を再現すると、JST 8/1 0:01は誤って7月分の集計窓に含まれ続けてしまう', () => {
  // 旧実装: new Date(now.getFullYear(), now.getMonth(), 1) はサーバーのローカル時刻で
  // 月初を計算する。RenderなどサーバーのローカルタイムゾーンがUTCの環境では、
  // now.getFullYear()/now.getMonth() は実質 now.getUTCFullYear()/now.getUTCMonth() と同じ値になる。
  // それを Date.UTC で厳密に再現する（このテストの実行環境自体のタイムゾーンに依存させないため）。
  const nowJustAfterMidnightJST = new Date('2026-07-31T15:01:00.000Z'); // JST 2026-08-01 00:01
  const legacyStartOfMonth = new Date(
    Date.UTC(nowJustAfterMidnightJST.getUTCFullYear(), nowJustAfterMidnightJST.getUTCMonth(), 1)
  ).toISOString();

  // UTC観点ではまだ7/31なので、旧実装の「月初」は7/1のまま（8月の集計窓に切り替わらない）
  assert.strictEqual(legacyStartOfMonth, '2026-07-01T00:00:00.000Z');

  // 修正後の実装は、JSTで日付が変わった時点（8/1 0:00 JST = 7/31 15:00 UTC）で正しく切り替わる
  const fixedStartOfMonth = getJSTMonthStartISO(nowJustAfterMidnightJST);
  assert.strictEqual(fixedStartOfMonth, '2026-07-31T15:00:00.000Z');

  // 旧実装は7月分の集計窓をそのまま延長してしまうため、7月中の配信（例：7/15）まで
  // 「今月」の集計に含め続けてしまう。修正後はJSTで月が変わった時点から正しくリセットされ、
  // 7月の配信は「今月」の集計から除外される。
  const julyBroadcastCreatedAt = new Date('2026-07-15T00:00:00.000Z');
  assert.ok(julyBroadcastCreatedAt.getTime() >= new Date(legacyStartOfMonth).getTime()); // 旧実装：誤って含めてしまう
  assert.ok(julyBroadcastCreatedAt.getTime() < new Date(fixedStartOfMonth).getTime()); // 修正後：正しく除外される
});

test('境界値: JST 7/31 23:59 の配信は7月分の月初以降・8月の月初より前になる', () => {
  // JST 2026-07-31 23:59 = UTC 2026-07-31T14:59:00.000Z
  const lastMomentOfJuly = new Date('2026-07-31T14:59:00.000Z');
  const startOfJuly = getJSTMonthStartISO(lastMomentOfJuly);
  // JST 2026-07-01 00:00 = UTC 2026-06-30T15:00:00.000Z
  assert.strictEqual(startOfJuly, '2026-06-30T15:00:00.000Z');
  assert.ok(lastMomentOfJuly.getTime() >= new Date(startOfJuly).getTime());

  // 8月の月初（2026-07-31T15:00:00.000Z）より前であること
  assert.ok(lastMomentOfJuly.getTime() < new Date('2026-07-31T15:00:00.000Z').getTime());
});
