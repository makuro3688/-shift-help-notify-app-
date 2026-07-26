require('dotenv').config();
const path = require('path');
const express = require('express');
const cors = require('cors');
const webpush = require('web-push');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_KEY = process.env.ADMIN_KEY || 'change-me-please';

if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
  console.error('❌ SUPABASE_URLとSUPABASE_SERVICE_KEYを.envに設定してください（.env.example参照）。');
  process.exit(1);
}

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

function mapShift(row) {
  return {
    id: row.id,
    store_name: row.store_name,
    date: row.date,
    time: row.time,
    note: row.note || '',
    status: row.status,
    filledBy: row.filled_by,
    filledAt: row.filled_at,
    createdAt: row.created_at,
  };
}

async function getConfig(key) {
  const { data, error } = await supabase.from('app_config').select('value').eq('key', key).maybeSingle();
  if (error) throw error;
  return data ? data.value : null;
}

async function setConfig(key, value) {
  const { error } = await supabase.from('app_config').upsert({ key, value });
  if (error) throw error;
}

async function loadOrCreateVapidKeys() {
  const [publicKey, privateKey] = await Promise.all([getConfig('vapid_public_key'), getConfig('vapid_private_key')]);
  if (publicKey && privateKey) return { publicKey, privateKey };

  const keys = webpush.generateVAPIDKeys();
  await setConfig('vapid_public_key', keys.publicKey);
  await setConfig('vapid_private_key', keys.privateKey);
  console.log('🔑 新しいVAPID鍵を生成しました（Supabaseのapp_configテーブルに保存済み。以後はこれを使い回します）');
  return keys;
}

async function main() {
  const vapidKeys = await loadOrCreateVapidKeys();
  webpush.setVapidDetails(
    process.env.VAPID_CONTACT_EMAIL ? `mailto:${process.env.VAPID_CONTACT_EMAIL}` : 'mailto:example@example.com',
    vapidKeys.publicKey,
    vapidKeys.privateKey
  );

  console.log('=========================================');
  console.log('🔑 PUBLIC VAPID KEY:', vapidKeys.publicKey);
  console.log('=========================================');

  app.use(cors());
  app.use(express.json());
  app.use(express.static(path.join(__dirname, 'public')));

  function requireAdmin(req, res, next) {
    const key = req.headers['x-admin-key'];
    if (key !== ADMIN_KEY) {
      return res.status(401).json({ error: '認証エラー：管理者キーが違います' });
    }
    next();
  }

  app.get('/health', (req, res) => {
    res.status(200).send('ok');
  });

  app.get('/api/vapid-public-key', (req, res) => {
    res.json({ publicKey: vapidKeys.publicKey });
  });

  app.post('/api/subscribe', async (req, res) => {
    const subscription = req.body;
    if (!subscription || !subscription.endpoint) {
      return res.status(400).json({ error: '不正なリクエストです' });
    }
    try {
      const { data: existing, error: selErr } = await supabase
        .from('subscriptions')
        .select('id')
        .eq('endpoint', subscription.endpoint)
        .maybeSingle();
      if (selErr) throw selErr;

      if (!existing) {
        const { error: insErr } = await supabase
          .from('subscriptions')
          .insert({ endpoint: subscription.endpoint, subscription });
        if (insErr) throw insErr;
      }

      const { count, error: countErr } = await supabase
        .from('subscriptions')
        .select('*', { count: 'exact', head: true });
      if (countErr) throw countErr;

      res.status(201).json({ message: '宛先を保存しました', count });
    } catch (err) {
      console.error('subscribe error:', err);
      res.status(500).json({ error: '宛先の保存に失敗しました' });
    }
  });

  app.post('/api/send-broadcast', requireAdmin, async (req, res) => {
    const { store_name, date, time, note } = req.body;
    if (!store_name || !date || !time) {
      return res.status(400).json({ error: '店舗名・日付・時間は必須です' });
    }

    try {
      const { data: shift, error: insErr } = await supabase
        .from('shifts')
        .insert({ store_name, date, time, note: note || '' })
        .select()
        .single();
      if (insErr) throw insErr;

      const shiftId = shift.id;
      const baseUrl = process.env.APP_URL || process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;
      const payload = JSON.stringify({
        title: `🚨【急募】${store_name}`,
        body: `【日時】${date} ${time}${note ? '\n' + note : ''}\n先着1名です。タップして応募！`,
        url: `${baseUrl}/respond.html?id=${shiftId}`,
      });

      const { data: subs, error: subsErr } = await supabase.from('subscriptions').select('*');
      if (subsErr) throw subsErr;

      let sent = 0;
      let failed = 0;
      const staleEndpoints = [];

      await Promise.all(
        (subs || []).map(async (s) => {
          try {
            await webpush.sendNotification(s.subscription, payload);
            sent++;
          } catch (err) {
            failed++;
            if (err.statusCode === 410 || err.statusCode === 404) {
              staleEndpoints.push(s.endpoint);
            }
            console.error('送信失敗:', err.statusCode, s.endpoint);
          }
        })
      );

      if (staleEndpoints.length) {
        await supabase.from('subscriptions').delete().in('endpoint', staleEndpoints);
      }

      res.json({ message: `${sent}台に送信しました（失敗: ${failed}）`, shiftId });
    } catch (err) {
      console.error('send-broadcast error:', err);
      res.status(500).json({ error: '配信に失敗しました' });
    }
  });

  app.get('/api/shift/:id', async (req, res) => {
    const { data, error } = await supabase.from('shifts').select('*').eq('id', req.params.id).maybeSingle();
    if (error) {
      console.error('get shift error:', error);
      return res.status(500).json({ error: '取得に失敗しました' });
    }
    if (!data) return res.status(404).json({ error: '募集が見つかりません' });
    res.json(mapShift(data));
  });

  app.post('/api/shift/:id/respond', async (req, res) => {
    try {
      const { data, error } = await supabase
        .from('shifts')
        .update({
          status: 'filled',
          filled_by: (req.body && req.body.name) || '匿名スタッフ',
          filled_at: new Date().toISOString(),
        })
        .eq('id', req.params.id)
        .eq('status', 'open')
        .select()
        .maybeSingle();
      if (error) throw error;

      if (data) {
        return res.json({ message: '応募が完了しました！ありがとうございます。', shift: mapShift(data) });
      }

      const { data: existing, error: existErr } = await supabase
        .from('shifts')
        .select('*')
        .eq('id', req.params.id)
        .maybeSingle();
      if (existErr) throw existErr;
      if (!existing) return res.status(404).json({ error: '募集が見つかりません' });
      return res.status(409).json({ error: '残念、すでに他のスタッフが対応済みです', shift: mapShift(existing) });
    } catch (err) {
      console.error('respond error:', err);
      res.status(500).json({ error: '応募処理に失敗しました' });
    }
  });

  app.get('/api/shifts', requireAdmin, async (req, res) => {
    const { data, error } = await supabase.from('shifts').select('*').order('created_at', { ascending: false });
    if (error) {
      console.error('list shifts error:', error);
      return res.status(500).json({ error: '取得に失敗しました' });
    }
    res.json((data || []).map(mapShift));
  });

  app.listen(PORT, () => console.log(`Server running: http://localhost:${PORT}`));
}

main().catch((err) => {
  console.error('起動に失敗しました:', err);
  process.exit(1);
});
