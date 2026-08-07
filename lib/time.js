'use strict';

// 日本時間（JST, UTC+9）基準で「今月の1日 0:00」のUTC ISO文字列を求める。
// Render等サーバーのローカル時刻がUTCの環境で `new Date(now.getFullYear(), now.getMonth(), 1)` を
// そのまま使うと、日本時間で月が変わった後（JST 0:00〜9:00）もUTCではまだ前月扱いのため、
// 月初の配信が前月分としてカウントされてしまう。これを避けるため、JSTでの年月を明示的に求めてから
// 「JSTでのその月の1日 0:00」に相当するUTC時刻を計算する。
const JST_OFFSET_MINUTES = 9 * 60; // UTC+9（分単位）
const MS_PER_MINUTE = 60 * 1000;

function getJSTMonthStartISO(now = new Date()) {
  // UTC時刻にJSTのオフセットを加算すると、getUTCFullYear/getUTCMonthで
  // 「日本時間で見たときの年月」を取り出せる（Dateオブジェクト自体の値は変わらない点に注意）
  const jstClock = new Date(now.getTime() + JST_OFFSET_MINUTES * MS_PER_MINUTE);
  const jstYear = jstClock.getUTCFullYear();
  const jstMonth = jstClock.getUTCMonth();

  // 「JSTでその年月の1日 0:00」をUTCのミリ秒に変換する
  // （JSTの月初0:00 = UTCでは前月末日の15:00）
  const jstMonthStartAsUtcMs = Date.UTC(jstYear, jstMonth, 1, 0, 0, 0) - JST_OFFSET_MINUTES * MS_PER_MINUTE;
  return new Date(jstMonthStartAsUtcMs).toISOString();
}

module.exports = { getJSTMonthStartISO, JST_OFFSET_MINUTES };
