'use strict';

// AC-F11 / M-3是正: /api/report にサービス全体のグローバル上限があり、
// 送信元IPをローテーションする攻撃者（IP単位の制限を素通りできる攻撃者）に対しても
// 一定件数で受け付けを止められることを検証する。
//
// server.js自体はrequireするとSupabase/Stripe等へ接続してapp.listen()まで進む作りのため、
// test/trustProxy.test.js と同じ方針で、server.jsの/api/reportハンドラ（IP単位の
// isReportRequestAllowed → グローバルのisReportAllowedGloballyの順にチェックする構成）を
// 本物のlib/rateLimit.js（モックではない）を使って最小のExpressアプリで再現し、検証する。
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const { createRateLimiter } = require('../lib/rateLimit');

// server.js:270〜277 と同じ設定（Renderの前段プロキシは1段のため、XFFの右端だけを信頼する）。
const TRUSTED_PROXY_HOPS = 1;

// server.jsの /api/report ハンドラ（IP単位チェック→グローバルチェックの順）を再現する。
// IP単位の上限(ipMaxRequests)を意図的に大きくすることで、「攻撃者が毎回別IPを名乗れば
// IP単位の制限は素通りできる」状況（PoCで実証された状況そのもの）を再現できる。
function buildApp({ ipMaxRequests, globalMaxRequests, withGlobalLimit }) {
  const app = express();
  app.set('trust proxy', TRUSTED_PROXY_HOPS);
  const isIpAllowed = createRateLimiter(10 * 60 * 1000, ipMaxRequests);
  const isGlobalAllowed = createRateLimiter(60 * 60 * 1000, globalMaxRequests);

  app.post('/api/report', (req, res) => {
    const clientIp = req.ip || (req.connection && req.connection.remoteAddress) || 'unknown';
    if (!isIpAllowed(clientIp)) {
      return res.status(429).json({ error: 'ip rate limited' });
    }
    // M-3是正: グローバル上限のチェックを、そもそも入れるかどうかを切り替えられるようにして、
    // 「入れなければ攻撃が成立し、入れれば止まる」ことを同一のテストコードで対比できるようにする。
    if (withGlobalLimit && !isGlobalAllowed('global')) {
      return res.status(503).json({ error: 'global rate limited' });
    }
    res.status(201).json({ ip: clientIp });
  });
  return app;
}

// 新規依存を増やさないため、node:httpだけでリクエストを送る（trustProxy.test.jsと同じ方式）。
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

// 攻撃者が異なる送信元IPをN個用意し、1IPにつき1回だけ送信するシナリオを作る。
// （SECURITY_REVIEW_2.mdのPoC項目[D]「5000個の別IPv6アドレスから1回ずつ送信→通過=5000/5000」の再現）
async function floodFromDistinctIps(server, count) {
  const results = [];
  for (let i = 0; i < count; i++) {
    // XFFの右端（trust proxy=1で信頼される値）を毎回変えることで、別々の実IPを模擬する。
    results.push(await postReport(server, { 'x-forwarded-for': `198.51.100.1, 203.0.113.${i}` }));
  }
  return results;
}

test('正常系(AC-F11): 上限件数までは異なるIPからの通報でも正常に受け付けられる', async () => {
  const app = buildApp({ ipMaxRequests: 100, globalMaxRequests: 5, withGlobalLimit: true });
  const server = app.listen(0);
  try {
    const results = await floodFromDistinctIps(server, 5);
    // グローバル上限(5件)以内なので、異なるIPからでも全件201で受け付けられる
    // （＝正規の分散利用を過剰にブロックする副作用が無いことの確認）。
    assert.strictEqual(results.filter((r) => r.status === 201).length, 5);
    assert.strictEqual(results.filter((r) => r.status === 503).length, 0);
  } finally {
    server.close();
  }
});

test('異常系(AC-F11): IPを変え続ける攻撃者に対しても、グローバル上限に達すると一律で受け付けが止まる', async () => {
  // IP単位の上限(100)は十分大きく、8回の送信ではどのIPも単体では引っかからない。
  // つまりIP単位の制限だけでは、この攻撃は1件も止められない状況を作っている。
  const app = buildApp({ ipMaxRequests: 100, globalMaxRequests: 5, withGlobalLimit: true });
  const server = app.listen(0);
  try {
    const results = await floodFromDistinctIps(server, 8);
    // グローバル上限(5件)に達した6件目以降は、異なるIPから来ていても503で拒否される。
    assert.strictEqual(results.filter((r) => r.status === 201).length, 5);
    assert.strictEqual(results.filter((r) => r.status === 503).length, 3);
    // 拒否された応答はいずれもグローバル上限によるものであり、IP単位の429ではない。
    assert.strictEqual(results.filter((r) => r.status === 429).length, 0);
  } finally {
    server.close();
  }
});

test('異常系(対比・是正前の再現): グローバル上限を入れない場合、IPを変え続けるだけで際限なく通過してしまう', async () => {
  // withGlobalLimit: false で、M-3是正前（IP単位の制限のみ）の状態を再現する。
  const app = buildApp({ ipMaxRequests: 100, globalMaxRequests: 5, withGlobalLimit: false });
  const server = app.listen(0);
  try {
    const results = await floodFromDistinctIps(server, 20);
    // グローバル上限が無ければ、20回のIPローテーション送信が全て通ってしまう
    // （このテストが無いと、上の異常系テストが「たまたま止まっただけ」の可能性を排除できない）。
    assert.strictEqual(results.every((r) => r.status === 201), true);
  } finally {
    server.close();
  }
});
