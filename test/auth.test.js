'use strict';

// AC-H3-4: 時間帯責任者（supervisor）のキーでは退会APIを実行できないことを検証する。
// /api/withdraw は requireAdmin の後段で requireOwner を通しており、requireOwner が
// この認可を担っている（server.jsから抜き出したlib/auth.jsを直接テストする）。
const test = require('node:test');
const assert = require('node:assert/strict');
const { requireOwner } = require('../lib/auth');

function createFakeRes() {
  const res = {
    statusCode: null,
    body: null,
    status(code) {
      res.statusCode = code;
      return res;
    },
    json(payload) {
      res.body = payload;
      return res;
    },
  };
  return res;
}

test('正常系: role=ownerなら次の処理（退会APIの本体）に進める', () => {
  let nextCalled = false;
  const req = { role: 'owner' };
  const res = createFakeRes();
  requireOwner(req, res, () => {
    nextCalled = true;
  });
  assert.strictEqual(nextCalled, true);
  assert.strictEqual(res.statusCode, null); // エラーレスポンスは返っていない
});

test('異常系: role=supervisor（時間帯責任者）は403で拒否され、退会APIの本体には進めない', () => {
  let nextCalled = false;
  const req = { role: 'supervisor' };
  const res = createFakeRes();
  requireOwner(req, res, () => {
    nextCalled = true;
  });
  assert.strictEqual(nextCalled, false);
  assert.strictEqual(res.statusCode, 403);
  assert.match(res.body.error, /オーナー・店長のみ/);
});
