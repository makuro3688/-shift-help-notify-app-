'use strict';

// オーナー・店長専用の操作（スタッフ管理・料金確認・契約更新・プラン変更・解約・
// 支払方法変更・時間帯責任者の発行/失効・店舗の退会）を守るミドルウェア。
// server.js の requireAdmin（管理者キーを検証し req.role を 'owner' | 'supervisor' にセットする）
// の後段で使うことを想定している。
// 外部サービス（Supabase等）に依存しない純粋なロジックのため、withdraw等の重要な認可を
// ユニットテストで直接検証できるように server.js から切り出している。
function requireOwner(req, res, next) {
  if (req.role !== 'owner') {
    return res.status(403).json({ error: 'この操作はオーナー・店長のみ行えます' });
  }
  next();
}

module.exports = { requireOwner };
