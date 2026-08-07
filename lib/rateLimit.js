'use strict';

// 固定ウィンドウ方式の単純なレート制限。
// 通報API（/api/report）は、スタッフが管理者キーを持たないため認証なしで呼べる必要があるが、
// 認証なしで誰でも呼べると荒らしの標的になりうるため、同一キー（通常はIPアドレス）からの
// 短時間の大量送信を制限するために使う。
// プロセス内メモリで状態を持つため、複数インスタンス構成では制限が共有されない点に注意
// （本アプリはRender無料プランでの単一インスタンス運用を前提としているため許容している）。

// キー長の上限。ヘッダ（X-Forwarded-For等）に長大な文字列を仕込まれても、
// 1キーあたりのメモリ使用量を一定に抑えるための防御（多層防御。server.jsのtrust proxy設定
// を1ホップに限定したのが本質的な対策だが、それだけに依存しない）。
const MAX_KEY_LENGTH = 64;

// Mapに保持するキー（=識別子）の種類数の上限。
// これを超えたら期限切れ・空になったエントリを掃除し、それでも超える場合は
// 最も古いエントリ（Mapは挿入順を保持する）から捨てる。
// 掃除処理が無いと、無認証で呼べるAPIに対して毎回異なるキーを送りつけられるだけで
// Mapのエントリ数が際限なく増え続け、プロセスがOOMでクラッシュする恐れがある。
const MAX_TRACKED_KEYS = 10000;

function createRateLimiter(windowMs, maxRequests, maxTrackedKeys = MAX_TRACKED_KEYS) {
  const hitsByKey = new Map(); // key -> 直近のリクエスト時刻(ms)の配列

  // ウィンドウ外になった時刻だけになった（＝空になった）エントリをMapから削除する。
  // 削除しないと、一度でもリクエストしたキーが永久にMapへ残り続けてしまう。
  function sweepExpiredEntries(now) {
    for (const [k, times] of hitsByKey) {
      const recent = times.filter((t) => now - t < windowMs);
      if (recent.length === 0) {
        hitsByKey.delete(k);
      } else if (recent.length !== times.length) {
        hitsByKey.set(k, recent);
      }
    }
  }

  function isAllowed(rawKey) {
    // キーは固定長に切り詰める。長大な文字列（例: 偽装したX-Forwarded-For）を
    // そのままキーにすると、1リクエストごとにキー文字列分のメモリが消費されてしまう。
    const key = String(rawKey).slice(0, MAX_KEY_LENGTH);
    const now = Date.now();

    // 追跡中のキー数が上限を超えたら掃除する。存在するキーの数を毎回数えるコストを
    // 避けるため、上限を超えたときだけ掃除を行う（通常運用では滅多に発生しない）。
    if (hitsByKey.size > maxTrackedKeys) {
      sweepExpiredEntries(now);
      // 掃除してもなお上限を超える場合は、最も古く追加されたキーから捨てる
      // （Mapは挿入順を保持するため、keys().next()が最古のキーになる）。
      while (hitsByKey.size > maxTrackedKeys) {
        hitsByKey.delete(hitsByKey.keys().next().value);
      }
    }

    const recent = (hitsByKey.get(key) || []).filter((t) => now - t < windowMs);
    if (recent.length >= maxRequests) {
      hitsByKey.set(key, recent);
      return false;
    }
    recent.push(now);
    hitsByKey.set(key, recent);
    return true;
  }

  // テスト・監視用に、現在追跡中のキー数と明示的な掃除を公開する。
  // 内部Mapそのものは公開しない（外部から書き換えられないようにするため）。
  isAllowed.getTrackedKeyCount = () => hitsByKey.size;
  isAllowed.sweepExpiredEntries = () => sweepExpiredEntries(Date.now());

  return isAllowed;
}

module.exports = { createRateLimiter, MAX_KEY_LENGTH, MAX_TRACKED_KEYS };
