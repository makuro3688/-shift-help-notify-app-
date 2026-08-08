'use strict';

// M-3: 深夜勤務（22時〜翌5時）判定ロジック
//
// 背景：労働基準法61条により、18歳未満（年少者）は原則、午後10時〜午前5時の就労が禁止されている。
// DAIDA+では年齢の入力・保存は行わない設計方針のため（自己申告依存・個人情報増加を避けるため）、
// 「代理募集の時間帯が深夜にかかるかどうか」を自由入力の文字列から機械的に判定し、
// 責任を負うオーナー・店長に配信前の注意喚起を行うための補助ロジックである。
// ※ この判定はあくまで「注意喚起の要否」を決めるものであり、配信をブロックするものではない。
//
// このファイルは Node（サーバー側テスト・server.js）と、ブラウザ（manager.html等で
// <script src="/lib/nightWork.js"> として読み込む場合）の両方から利用できるよう、
// module.exports / window.NightWork の両方に同じAPIを公開するUMD風の構成にしている。

// 労働基準法61条が定める深夜就労禁止の境界時刻（マジックナンバー回避のため名前付き定数化）
const NIGHT_START_HOUR = 22; // 午後10時（22時）から…
const NIGHT_END_HOUR = 5; // …翌午前5時まで、18歳未満の就労は原則禁止

const MINUTES_PER_HOUR = 60;
const HOURS_PER_DAY = 24;

// 時刻が数値として読み取れなくても、これらの語があれば深夜シフトの可能性が高いとみなし、
// 警告対象としてよい（仕様上「してもよい」とされているオプション的な救済措置）
const NIGHT_KEYWORDS = ['深夜', '翌', '早朝'];

// 時刻トークン抽出用の正規表現。
// 「コロン(:／：) + 分」または「時（＋分）」が直後に続く数値だけを時刻として拾う。
// これにより「10名」「1500円」のような時刻と無関係な数値を誤って時刻とみなさない。
// 例: "18:00" "22時" "翌2:00" "18時30分" "25:00"（24時以降表記もそのまま2桁の数値として拾う）
const TIME_TOKEN_RE = /(翌)?(\d{1,2})(?:[:：](\d{1,2})|時(?:(\d{1,2})分)?)/g;

// 入力文字列から時刻トークン（「翌」の有無・時・分）を順番に抽出する
function extractTimeTokens(text) {
  const tokens = [];
  TIME_TOKEN_RE.lastIndex = 0; // グローバル正規表現のstate leakを防ぐため毎回リセットする
  let match = TIME_TOKEN_RE.exec(text);
  while (match !== null) {
    tokens.push({
      hasNextDayPrefix: Boolean(match[1]), // 「翌」が付いていたか
      hour: parseInt(match[2], 10),
      minute: parseInt(match[3] || match[4] || '0', 10),
    });
    match = TIME_TOKEN_RE.exec(text);
  }
  return tokens;
}

function toMinutes(hour, minute) {
  return hour * MINUTES_PER_HOUR + minute;
}

// [startMin, endMin) の区間が、深夜帯（当日22:00〜翌5:00）と重なるかを判定する。
// 開始・終了はいずれも「シフト開始日 0:00」を起点とした分単位（日をまたぐ場合は24:00超もありうる）。
function rangeOverlapsNight(startMin, endMin) {
  const nightWindows = [
    [0, NIGHT_END_HOUR * MINUTES_PER_HOUR], // 当日 0:00〜5:00（早朝側）
    [NIGHT_START_HOUR * MINUTES_PER_HOUR, HOURS_PER_DAY * MINUTES_PER_HOUR], // 当日 22:00〜24:00
    [HOURS_PER_DAY * MINUTES_PER_HOUR, (HOURS_PER_DAY + NIGHT_END_HOUR) * MINUTES_PER_HOUR], // 翌日 0:00〜5:00
  ];
  // 半開区間同士の重なり判定: start < 相手のend かつ 相手のstart < end
  return nightWindows.some(([windowStart, windowEnd]) => startMin < windowEnd && windowStart < endMin);
}

function containsNightKeyword(text) {
  return NIGHT_KEYWORDS.some((keyword) => text.includes(keyword));
}

/**
 * 自由入力の時間帯テキスト（例："18:00〜22:00" "22:00〜翌2:00" "深夜シフト"）から、
 * 22時〜翌5時の深夜帯にかかる可能性があるかを判定する。
 *
 * 方針：
 * - パースできる場合は「開始時刻・終了時刻」として区間を組み立て、深夜帯と重なるか判定する。
 * - 時刻が1つしか読み取れない場合は、その時刻単体が深夜帯に属するかで判定する。
 * - 時刻がまったく読み取れない場合は、キーワード（深夜・翌・早朝）の有無でのみ判定する。
 * - パースできず、キーワードもない場合は false を返す（警告を出さない）。
 *   毎回警告を出すと「またか」と無視されるようになり、かえって危険なため、
 *   自信を持って深夜と判定できる場合にのみ警告対象とする。
 * - どのようなおかしな入力を渡してもエラーは投げない（配信フローを止めないため）。
 *
 * @param {string} timeText 時間欄の自由入力文字列
 * @returns {boolean} 深夜帯（22時〜翌5時）にかかる可能性があれば true
 */
function isNightWork(timeText) {
  if (typeof timeText !== 'string') return false;
  const text = timeText.trim();
  if (!text) return false;

  const tokens = extractTimeTokens(text);

  if (tokens.length === 0) {
    // 時刻を数値として読み取れない場合は、キーワードのみで判定する（例："深夜シフト"）
    return containsNightKeyword(text);
  }

  if (tokens.length === 1) {
    // 開始・終了の一方しか読み取れない場合は、その時刻単体が深夜帯に属するかで判定する
    const only = tokens[0];
    const isSingleTimeAtNight = only.hour >= NIGHT_START_HOUR || only.hour < NIGHT_END_HOUR;
    return isSingleTimeAtNight || containsNightKeyword(text);
  }

  // 2つ以上見つかった場合は、最初を開始時刻、2つ目を終了時刻として扱う
  const start = tokens[0];
  const end = tokens[1];
  const startMin = toMinutes(start.hour, start.minute);
  let endMin = toMinutes(end.hour, end.minute);

  // 「翌」が明示されている、または終了時の時が開始時より小さい（日をまたぐ）場合は、
  // 終了時刻を24時間分繰り下げて日またぎの区間として扱う。
  // 24時・25時などの「24時以降表記」はこの時点ですでに開始時より大きい数値になっているため、
  // 二重に加算されることはない。
  const crossesMidnight = end.hasNextDayPrefix || end.hour < start.hour;
  if (crossesMidnight) {
    endMin += HOURS_PER_DAY * MINUTES_PER_HOUR;
  }

  if (endMin <= startMin) {
    // 終了が開始以前など、区間として信頼できない並びの場合はキーワードのみで判定する
    return containsNightKeyword(text);
  }

  return rangeOverlapsNight(startMin, endMin) || containsNightKeyword(text);
}

const api = {
  isNightWork,
  NIGHT_START_HOUR,
  NIGHT_END_HOUR,
};

// Node（server.js・テスト）からの利用
if (typeof module === 'object' && module.exports) {
  module.exports = api;
}
// ブラウザから <script src="/lib/nightWork.js"> で読み込んだ場合の利用
if (typeof window !== 'undefined') {
  window.NightWork = api;
}
