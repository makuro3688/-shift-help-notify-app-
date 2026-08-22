'use strict';

// 送信するメールが「販促メール」と判定されにくい作りになっていることを検証する。
//
// 【背景・実測】本番で確認したところ、同じ送信元(send.daida-store.jp)から送っているのに
// 振り分け先が分かれた。
//   ・確認コードのメール → Gmailの「メイン」タブ
//   ・確定通知のメール   → Gmailの「プロモーション」タブ
// 2通の違いは次の2点だけだった。
//   ① 件名の先頭に 【】 が付いていた
//   ② 本文が <ul><li> の箇条書きだった
// 日本語圏では 【】 付きの件名と箇条書きの本文がメルマガ・販促メールの典型であり、
// Gmailの分類器はこれを手がかりのひとつにしていると考えられる。
//
// 【なぜテストにするのか】確定通知は「すぐ気づいてほしい業務連絡」であり、
// プロモーションタブに入ると店長が見るのは何時間も後になる。機能そのものの価値が失われる。
// しかも、この不具合は**アプリのエラーとして一切表れない**。メールは正常に送信され、
// APIは成功を返し、ログにも何も出ない。受信者のタブが違うだけなので、
// 気づけるのは「実際に受け取って目で見たとき」だけである。
// 一度直しても、後から件名を装飾したくなったときに簡単に戻ってしまうため、
// 構造として固定しておく。
//
// 【このテストの限界（正直に書いておく）】
// これはあくまで「販促メールに見えやすい既知のパターンを避けている」ことの確認であり、
// **Gmailのメインタブに入ることを保証するものではない**。Gmailの判定基準は公開されておらず、
// 送信ドメインの実績や受信者ごとの操作履歴にも左右される。運用側の対策
// （店長向けの案内に「最初の1通はプロモーションタブも確認してメインへ移動」と書く）と
// 必ずセットで運用すること。
const test = require('node:test');
const assert = require('node:assert/strict');

if (!process.env.RESEND_API_KEY) {
  process.env.RESEND_API_KEY = 'test-dummy-resend-api-key';
}

// Resendへの送信(fetch)を横取りして、実際に組み立てられたリクエストボディを捕まえる。
// これにより「メール関数が何を送ろうとしたか」をそのまま検証できる。
function captureSentEmails(fn) {
  const sent = [];
  const originalFetch = global.fetch;
  global.fetch = async (url, options) => {
    if (String(url).includes('api.resend.com')) {
      sent.push(JSON.parse(options.body));
      return { ok: true, status: 200, text: async () => '' };
    }
    return originalFetch(url, options);
  };
  return fn(sent).finally(() => {
    global.fetch = originalFetch;
  });
}

// server.js は buildApp をエクスポートしているが、メール送信関数そのものは
// エクスポートしていない。実際に使われる経路（buildApp内のoverrides未指定＝本物）を
// 通すため、アプリ経由ではなくモジュールを読み込んで内部関数を呼ぶのではなく、
// 「本物のメール関数が使われる状態のアプリ」を立てて、HTTP経由で発火させる。
const { buildApp } = require('../server');
const crypto = require('node:crypto');
const http = require('node:http');

function hashKey(key) {
  return crypto.createHash('sha256').update(key).digest('hex');
}
function post(server, path, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const { port } = server.address();
    const payload = JSON.stringify(body);
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        method: 'POST',
        path,
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload), ...headers },
      },
      (res) => {
        let raw = '';
        res.on('data', (c) => (raw += c));
        res.on('end', () => resolve({ status: res.statusCode, raw }));
      }
    );
    req.on('error', reject);
    req.end(payload);
  });
}
function waitFor(fn, { timeoutMs = 1500, intervalMs = 5 } = {}) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    (function check() {
      if (fn()) return resolve();
      if (Date.now() > deadline) return reject(new Error('waitFor: タイムアウト'));
      setTimeout(check, intervalMs);
    })();
  });
}

const OWNER_KEY = 'owner-key-deliverability-test';
const STORE = {
  id: 'store-1',
  name: 'あああ店',
  email: 'owner@example.com',
  admin_key_hash: hashKey(OWNER_KEY),
  created_at: new Date().toISOString(),
  subscription_status: 'trial',
};
const SHIFT = {
  id: 'shift-1',
  store_id: 'store-1',
  store_name: 'あああ店',
  date: '2026-08-25',
  time: '18:00〜22:00',
  note: '',
  status: 'open',
  filled_by: null,
  filled_at: null,
  created_by_supervisor_id: null,
  created_at: new Date().toISOString(),
};
const STAFF = {
  id: 'sub-1',
  endpoint: 'https://push.example.com/staff-1',
  subscription: { endpoint: 'https://push.example.com/staff-1', keys: { p256dh: 'x', auth: 'y' } },
  store_id: 'store-1',
  store_name: 'あああ店',
  staff_name: 'あち',
  registered_at: new Date().toISOString(),
};

function fakeSupabase() {
  const stores = [{ ...STORE }];
  const shifts = [{ ...SHIFT }];
  const subs = [{ ...STAFF }];
  const chain = (rows) => ({
    eq: (c, v) => chain(rows.filter((r) => r[c] === v)),
    maybeSingle: () => Promise.resolve({ data: rows[0] ? { ...rows[0] } : null, error: null }),
    then: (res, rej) => Promise.resolve({ data: rows.map((r) => ({ ...r })), error: null }).then(res, rej),
  });
  return {
    shifts,
    from(table) {
      if (table === 'stores') return { select: () => chain(stores) };
      if (table === 'supervisor_keys') return { select: () => chain([]) };
      if (table === 'subscriptions') {
        return { select: () => chain(subs), delete: () => ({ in: () => Promise.resolve({ error: null }) }) };
      }
      if (table === 'shifts') {
        return {
          select: () => chain(shifts),
          update: (payload) => {
            let m = shifts;
            const c = {
              eq(col, val) {
                m = m.filter((r) => r[col] === val);
                return c;
              },
              select: () => ({
                maybeSingle: () => {
                  if (m.length === 1) {
                    Object.assign(m[0], payload);
                    return Promise.resolve({ data: { ...m[0] }, error: null });
                  }
                  return Promise.resolve({ data: null, error: null });
                },
              }),
            };
            return c;
          },
        };
      }
      throw new Error(`想定外のテーブル: ${table}`);
    },
  };
}

// ============================================================
// 確定通知メール（★最重要。プロモーションタブに入っていた当のメール）
// ============================================================

test('正常系(★核心): 確定通知メールの件名に 【】 が含まれない', async () => {
  await captureSentEmails(async (sent) => {
    // sendShiftFilledNotificationEmail をoverrideしない＝本物が使われる
    const app = buildApp({ supabase: fakeSupabase(), sendPushNotification: async () => {} });
    const server = app.listen(0);
    try {
      const res = await post(server, `/api/shift/${SHIFT.id}/respond`, { name: 'あち' });
      assert.strictEqual(res.status, 200);
      await waitFor(() => sent.length >= 1);

      const mail = sent[0];
      assert.ok(
        !/[【】]/.test(mail.subject),
        `件名に 【】 を使わないこと（販促メールと判定されやすい）。実際の件名: ${mail.subject}`
      );
    } finally {
      server.close();
    }
  });
});

test('正常系(★核心): 確定通知メールの本文に箇条書き(<ul>/<li>)を使わない', async () => {
  await captureSentEmails(async (sent) => {
    const app = buildApp({ supabase: fakeSupabase(), sendPushNotification: async () => {} });
    const server = app.listen(0);
    try {
      await post(server, `/api/shift/${SHIFT.id}/respond`, { name: 'あち' });
      await waitFor(() => sent.length >= 1);

      const mail = sent[0];
      assert.ok(!/<ul[\s>]/.test(mail.html), '本文に <ul> を使わないこと');
      assert.ok(!/<li[\s>]/.test(mail.html), '本文に <li> を使わないこと');
    } finally {
      server.close();
    }
  });
});

test('正常系(★核心): 確定通知メールにプレーンテキスト版(text)が含まれる', async () => {
  await captureSentEmails(async (sent) => {
    const app = buildApp({ supabase: fakeSupabase(), sendPushNotification: async () => {} });
    const server = app.listen(0);
    try {
      await post(server, `/api/shift/${SHIFT.id}/respond`, { name: 'あち' });
      await waitFor(() => sent.length >= 1);

      const mail = sent[0];
      assert.ok(mail.text, 'HTMLだけでなくプレーンテキスト版も送ること');
      assert.ok(mail.text.includes('あち'), 'テキスト版にも応募者名が入っていること');
      assert.ok(!/<[a-z]/i.test(mail.text), 'テキスト版にHTMLタグが混ざっていないこと');
    } finally {
      server.close();
    }
  });
});

test('正常系: 確定通知メールは、件名だけで「誰が・いつ」が分かる情報を含む', async () => {
  await captureSentEmails(async (sent) => {
    const app = buildApp({ supabase: fakeSupabase(), sendPushNotification: async () => {} });
    const server = app.listen(0);
    try {
      await post(server, `/api/shift/${SHIFT.id}/respond`, { name: 'あち' });
      await waitFor(() => sent.length >= 1);

      const mail = sent[0];
      // 店長はスマホの通知画面で件名だけを見ることが多い。
      assert.ok(mail.subject.includes('あああ店'), '件名に店舗名（複数店舗の店長が区別できる）');
      assert.ok(mail.subject.includes('2026-08-25'), '件名に日付');
      assert.ok(mail.subject.includes('18:00〜22:00'), '件名に時間');
      // 本文には誰に決まったかが必要。
      assert.ok(mail.html.includes('あち'), '本文に応募者名');
    } finally {
      server.close();
    }
  });
});

test('異常系: 応募者名にHTMLタグを仕込まれても、本文でエスケープされる', async () => {
  await captureSentEmails(async (sent) => {
    const supabase = fakeSupabase();
    // なりすまし防止の照合を通すため、購読側の名前も同じ値にする
    const evil = '<script>alert(1)</script>';
    supabase.from('subscriptions'); // no-op（下でsubsを直接差し替えないため、専用のfakeを作る）
    const app = buildApp({
      supabase: {
        from(table) {
          if (table === 'subscriptions') {
            const rows = [{ ...STAFF, staff_name: evil }];
            const chain = (rs) => ({
              eq: (c, v) => chain(rs.filter((r) => r[c] === v)),
              maybeSingle: () => Promise.resolve({ data: rs[0] || null, error: null }),
              then: (res, rej) => Promise.resolve({ data: rs, error: null }).then(res, rej),
            });
            return { select: () => chain(rows), delete: () => ({ in: () => Promise.resolve({ error: null }) }) };
          }
          return supabase.from(table);
        },
      },
      sendPushNotification: async () => {},
    });
    const server = app.listen(0);
    try {
      await post(server, `/api/shift/${SHIFT.id}/respond`, { name: evil });
      await waitFor(() => sent.length >= 1);

      const mail = sent[0];
      assert.ok(!mail.html.includes('<script>'), 'HTML版でタグがそのまま出てはいけない');
      assert.ok(mail.html.includes('&lt;script&gt;'), 'エスケープされていること');
      // テキスト版はHTMLとして解釈されないため、エスケープしないのが正しい
      // （&amp; のような実体参照が文字として見えてしまうのを防ぐ）。
      assert.ok(!mail.text.includes('&lt;'), 'テキスト版では実体参照に変換しないこと');
    } finally {
      server.close();
    }
  });
});

// ============================================================
// 通報通知メール（運営宛。第13条2項の調査の起点になる）
// ============================================================

test('正常系: 通報通知メールも 【】 と箇条書きを使わず、テキスト版を持つ', async () => {
  await captureSentEmails(async (sent) => {
    const app = buildApp({
      supabase: {
        from(table) {
          if (table === 'reports') {
            return {
              insert: () => ({
                select: () => ({ single: () => Promise.resolve({ data: { id: 'r1' }, error: null }) }),
              }),
            };
          }
          if (table === 'stores') {
            const chain = (rows) => ({
              eq: () => chain(rows),
              maybeSingle: () => Promise.resolve({ data: rows[0] || null, error: null }),
            });
            return { select: () => chain([{ ...STORE }]) };
          }
          throw new Error(`想定外のテーブル: ${table}`);
        },
      },
    });
    const server = app.listen(0);
    try {
      const res = await post(server, '/api/report', {
        storeId: 'store-1',
        target: '対象',
        content: '内容',
        reporter: '通報者',
      });
      assert.strictEqual(res.status, 201, `通報の受付に失敗: ${res.raw}`);
      await waitFor(() => sent.length >= 1);

      const mail = sent[0];
      assert.ok(!/[【】]/.test(mail.subject), '件名に 【】 を使わないこと');
      assert.ok(!/<ul[\s>]/.test(mail.html), '本文に <ul> を使わないこと');
      assert.ok(mail.text, 'プレーンテキスト版を持つこと');
      assert.ok(mail.text.includes('内容'), 'テキスト版にも通報内容が入っていること');
    } finally {
      server.close();
    }
  });
});
