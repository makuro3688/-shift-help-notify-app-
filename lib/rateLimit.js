'use strict';

// 固定ウィンドウ方式の単純なレート制限。
// 通報API（/api/report）は、スタッフが管理者キーを持たないため認証なしで呼べる必要があるが、
// 認証なしで誰でも呼べると荒らしの標的になりうるため、同一キー（通常はIPアドレス）からの
// 短時間の大量送信を制限するために使う。
// プロセス内メモリで状態を持つため、複数インスタンス構成では制限が共有されない点に注意
// （本アプリはRender無料プランでの単一インスタンス運用を前提としているため許容している）。
function createRateLimiter(windowMs, maxRequests) {
  const hitsByKey = new Map(); // key -> 直近のリクエスト時刻(ms)の配列

  return function isAllowed(key) {
    const now = Date.now();
    const recent = (hitsByKey.get(key) || []).filter((t) => now - t < windowMs);
    if (recent.length >= maxRequests) {
      hitsByKey.set(key, recent);
      return false;
    }
    recent.push(now);
    hitsByKey.set(key, recent);
    return true;
  };
}

module.exports = { createRateLimiter };
