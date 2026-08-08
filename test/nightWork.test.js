'use strict';

// M-3 / AC-M3-7, AC-M3-8: 代理募集の時間欄（自由入力）から、
// 18歳未満が就労できない深夜帯（22時〜翌5時、労働基準法61条）にかかるかどうかを
// 判定するロジック（lib/nightWork.js）の検証。
//
// 目的は「配信をブロックすること」ではなく「オーナーへの注意喚起の要否を正しく判定すること」。
// 境界値（22時ちょうど・5時ちょうど）を誤って警告/非警告にしないことが特に重要なので、
// 境界値を中心にテストする。
const test = require('node:test');
const assert = require('node:assert/strict');
const { isNightWork, NIGHT_START_HOUR, NIGHT_END_HOUR } = require('../lib/nightWork');

test('定数: 深夜帯の境界は22時〜5時（労働基準法61条）である', () => {
  assert.strictEqual(NIGHT_START_HOUR, 22);
  assert.strictEqual(NIGHT_END_HOUR, 5);
});

test('境界値・正常系: "18:00〜22:00"（22時ちょうどに終わる）は深夜にかからないので警告しない', () => {
  assert.strictEqual(isNightWork('18:00〜22:00'), false);
});

test('境界値・正常系: "5:00〜9:00"（5時ちょうどに始まる）は深夜にかからないので警告しない', () => {
  assert.strictEqual(isNightWork('5:00〜9:00'), false);
});

test('境界値・異常系: "4:00〜9:00"（4時開始）は深夜（〜5時）にかかるので警告する', () => {
  assert.strictEqual(isNightWork('4:00〜9:00'), true);
});

test('異常系: "18:00〜23:00"（23時終了）は深夜にかかるので警告する', () => {
  assert.strictEqual(isNightWork('18:00〜23:00'), true);
});

test('異常系: "22:00〜翌2:00"（日をまたぐ深夜シフト）は警告する', () => {
  assert.strictEqual(isNightWork('22:00〜翌2:00'), true);
});

test('異常系: "21:00〜25:00"（24時以降表記を含む）は警告する', () => {
  assert.strictEqual(isNightWork('21:00〜25:00'), true);
});

test('表記ゆれ: ハイフン区切り "18:00-22:00" は境界どおり警告しない', () => {
  assert.strictEqual(isNightWork('18:00-22:00'), false);
});

test('表記ゆれ: ハイフン区切り "18:00-23:00" は警告する', () => {
  assert.strictEqual(isNightWork('18:00-23:00'), true);
});

test('表記ゆれ: 全角チルダ "18:00～25:00"（24時以降表記）は警告する', () => {
  assert.strictEqual(isNightWork('18:00～25:00'), true);
});

test('表記ゆれ: 「時」表記 "18時〜22時" は境界どおり警告しない', () => {
  assert.strictEqual(isNightWork('18時〜22時'), false);
});

test('表記ゆれ: 「時」表記 "22時〜翌5時"（法定の深夜帯そのもの）は警告する', () => {
  assert.strictEqual(isNightWork('22時〜翌5時'), true);
});

test('キーワード: 数値がなくても「深夜シフト」は警告する', () => {
  assert.strictEqual(isNightWork('深夜シフト'), true);
});

test('キーワード: 「早朝」を含む場合は警告する', () => {
  assert.strictEqual(isNightWork('早朝の品出し'), true);
});

test('単一時刻: "22:00"（終了時刻不明）は、その時刻自体が深夜帯なので警告する', () => {
  assert.strictEqual(isNightWork('22:00'), true);
});

test('単一時刻: "13:00"（終了時刻不明）は、その時刻自体は深夜帯でないので警告しない', () => {
  assert.strictEqual(isNightWork('13:00'), false);
});

test('パース不能・異常系: 空文字はエラーにならず、警告も出さない', () => {
  assert.strictEqual(isNightWork(''), false);
});

test('パース不能・異常系: 空白のみの文字列はエラーにならず、警告も出さない', () => {
  assert.strictEqual(isNightWork('   '), false);
});

test('パース不能・異常系: 記号だけの文字列はエラーにならず、警告も出さない', () => {
  assert.strictEqual(isNightWork('〜〜〜???'), false);
});

test('パース不能・異常系: "あいうえお"（時刻を含まない文字列）はエラーにならず、警告も出さない', () => {
  assert.strictEqual(isNightWork('あいうえお'), false);
});

test('パース不能・異常系: 時刻と紛らわしい無関係な数値（人数・金額）を誤って時刻と判定しない', () => {
  // "10名まで" "時給1500円" は時刻を表す数値ではないので、警告対象にしてはいけない
  assert.strictEqual(isNightWork('10名まで、時給1500円'), false);
});

test('入力型の異常系: null/undefined/数値など文字列以外が渡されてもエラーにならず、警告も出さない', () => {
  assert.strictEqual(isNightWork(null), false);
  assert.strictEqual(isNightWork(undefined), false);
  assert.strictEqual(isNightWork(12345), false);
});

test('日またぎの範囲外: "10:00〜18:00"（日中のみ）は警告しない', () => {
  assert.strictEqual(isNightWork('10:00〜18:00'), false);
});
