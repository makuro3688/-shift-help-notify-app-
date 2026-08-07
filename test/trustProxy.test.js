'use strict';

// AC-F1: server.js の `app.set('trust proxy', 1)`（H-1修正、server.js付近のTRUSTED_PROXY_HOPS）が、
// X-Forwarded-For の偽装によるレート制限回避を防いでいることを検証する。
//
// server.js自体は「必須の環境変数が無ければ即座にprocess.exit()する」「requireした瞬間に
// Supabase/Stripe/web-pushへ接続してapp.listen()まで進む」という、単体テストへの
// require を想定しない作りになっている（既存のtest/*.test.jsも同様にserver.jsを直接
// requireせず、lib/配下の実物のロジックを使ってserver.jsと同じ構成を再現する方式を取っている）。
// 本テストもその方針に合わせ、server.js:963付近と全く同じ「クライアントIPの取り出し方」
// （req.ip || ...）と、本物のlib/rateLimit.js（モックではない）を使い、
// server.jsと同一のtrust proxy設定を持つ最小のExpressアプリを組み立てて検証する。
// これはセキュリティ担当がSECURITY_REVIEW.md（H-1）で行ったPoCと同じ検証方法である。
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const { createRateLimiter } = require('../lib/rateLimit');

// server.js:263 と同じ値（Renderの前段プロキシは1段のため）。
const TRUSTED_PROXY_HOPS = 1;

// server.jsの /api/report ハンドラ（server.js:962〜）と同じ考え方で
// テスト用アプリを組み立てる。trustProxyの値だけを差し替えられるようにしている。
function buildApp({ trustProxy, windowMs, maxRequests }) {
  const app = express();
  app.set('trust proxy', trustProxy);
  const isAllowed = createRateLimiter(windowMs, maxRequests);
  app.post('/api/report', (req, res) => {
    // server.js:963 と同じ取得方法
    const clientIp = req.ip || (req.connection && req.connection.remoteAddress) || 'unknown';
    if (!isAllowed(clientIp)) {
      return res.status(429).json({ error: 'rate limited' });
    }
    res.status(201).json({ ip: clientIp });
  });
  return app;
}

// 新規依存を増やさないため、supertest等は使わずnode:httpだけでリクエストを送る。
function postReport(server, headers) {
  return new Promise((resolve, reject) => {
    const { port } = server.address();
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        method: 'POST',
        path: '/api/report',
        headers: { 'content-type': 'application/json', ...headers },
      },
      (res) => {
        let body = '';
        res.on('data', (chunk) => {
          body += chunk;
        });
        res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(body || '{}') }));
      }
    );
    req.on('error', reject);
    req.end('{}');
  });
}

test('正常系(AC-F1): trust proxyを1ホップに限定すると、X-Forwarded-Forの左側（攻撃者が書き換えられる部分）を毎回変えてもレート制限を回避できない', async () => {
  const app = buildApp({ trustProxy: TRUSTED_PROXY_HOPS, windowMs: 60_000, maxRequests: 3 });
  const server = app.listen(0);
  try {
    const results = [];
    for (let i = 0; i < 5; i++) {
      // 攻撃者が書き換えられるのは左側だけ。右端（Renderが実際に付与する想定の実IP）は固定。
      results.push(await postReport(server, { 'x-forwarded-for': `attacker-fake-${i}, 203.0.113.9` }));
    }
    // trust proxy=1では右端だけが信頼されるため、5回とも同一キー(203.0.113.9)として扱われ、
    // 上限3件を超えた4件目・5件目は429で拒否される。
    assert.strictEqual(results.filter((r) => r.status === 201).length, 3);
    assert.strictEqual(results.filter((r) => r.status === 429).length, 2);
    // 許可された応答のIPは、攻撃者が書き換えた左側の値ではなく、右端の値になっている
    for (const r of results.filter((res) => res.status === 201)) {
      assert.strictEqual(r.body.ip, '203.0.113.9');
    }
  } finally {
    server.close();
  }
});

test('異常系(修正前の再現・AC-F1の対比): trust proxyを全ホップ信頼(true)のままにすると、同じ攻撃でレート制限が回避されてしまう', async () => {
  // これはH-1修正前の`app.set('trust proxy', true)`を再現したものであり、
  // 「本テストが実際に効果を検証できている」ことの裏付けとして残す
  // （この対比が無ければ、上の正常系テストが「たまたま通っただけ」の可能性を排除できない）。
  const app = buildApp({ trustProxy: true, windowMs: 60_000, maxRequests: 3 });
  const server = app.listen(0);
  try {
    const results = [];
    for (let i = 0; i < 5; i++) {
      results.push(await postReport(server, { 'x-forwarded-for': `attacker-fake-${i}, 203.0.113.9` }));
    }
    // trust proxy=trueでは左端（攻撃者が書き換えた値）が使われるため、5回とも別キー扱いになり、
    // 429が1件も発生しない＝レート制限が完全に無効化される。
    assert.strictEqual(results.every((r) => r.status === 201), true);
    assert.strictEqual(results.filter((r) => r.status === 429).length, 0);
  } finally {
    server.close();
  }
});

test('境界値(AC-F1): X-Forwarded-Forヘッダが無い場合（直接接続）でも、実際の接続元アドレスでレート制限が正しく機能する', async () => {
  const app = buildApp({ trustProxy: TRUSTED_PROXY_HOPS, windowMs: 60_000, maxRequests: 2 });
  const server = app.listen(0);
  try {
    const results = [];
    for (let i = 0; i < 3; i++) {
      results.push(await postReport(server, {})); // X-Forwarded-Forを送らない
    }
    // ヘッダが無ければソケットの接続元アドレス（テスト環境では127.0.0.1で固定）が使われ、
    // 同一キーとして扱われて3回目は拒否される。
    assert.strictEqual(results.filter((r) => r.status === 201).length, 2);
    assert.strictEqual(results.filter((r) => r.status === 429).length, 1);
  } finally {
    server.close();
  }
});
