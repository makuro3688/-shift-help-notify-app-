require('dotenv').config();
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const cors = require('cors');
const webpush = require('web-push');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const PORT = process.env.PORT || 3000;

if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
  console.error('❌ SUPABASE_URLとSUPABASE_SERVICE_KEYを.envに設定してください（.env.example参照）。');
  process.exit(1);
}

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

// 店舗は「店舗名の文字列一致」ではなく、自動採番されるID(stores.id)で区別する。
// これにより、別々の会社が同じ店舗名（例："牛久店"）を使っても内部的には別物として扱われ、
// データが混ざることはない。
// 管理者キーは店長が自己登録した際にランダム生成され、DBにはハッシュ値のみ保存する
// （生の値はDBが漏れても使えない。ログイン時は同じ方法でハッシュ化して一致するものを検索する）。
function generateAdminKey() {
  return crypto.randomBytes(20).toString('hex'); // 40文字のランダムな文字列
}
function hashKey(key) {
  return crypto.createHash('sha256').update(key).digest('hex');
}

// shiftsテーブルの行(snake_case)をフロントエンドが期待する形に変換
function mapShift(row) {
  return {
    id: row.id,
    storeId: row.store_id,
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

// --- VAPID鍵：初回のみ生成し、以後はSupabase(app_config)に保存して使い回す ---
// ローカルファイルに保存する方式だとRenderの無料プランではスリープのたびに消えてしまうため、
// 外部DBであるSupabaseに保存することで、サーバーが何度再起動・スリープしても鍵が変わらないようにする。
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

  // 店長用エンドポイントの認証。管理者キーをハッシュ化し、一致する店舗をDBから探す。
  // 見つかった店舗のIDを req.storeId に入れることで、店長は自分の店舗の情報しか
  // 見えない・配信できない状態になる。
  async function requireAdmin(req, res, next) {
    const key = req.headers['x-admin-key'];
    if (!key) {
      return res.status(401).json({ error: '認証エラー：管理者キーが違います' });
    }
    try {
      const { data: store, error } = await supabase
        .from('stores')
        .select('id, name')
        .eq('admin_key_hash', hashKey(key))
        .maybeSingle();
      if (error) throw error;
      if (!store) {
        return res.status(401).json({ error: '認証エラー：管理者キーが違います' });
      }
      req.storeId = store.id;
      req.storeName = store.name;
      next();
    } catch (err) {
      console.error('auth error:', err);
      res.status(500).json({ error: '認証に失敗しました' });
    }
  }

  // 外形監視(UptimeRobot等)からの死活確認用。DBに触らず即応答するので軽い。
  // Renderの無料プランは15分無アクセスでスリープするため、これを5〜10分おきにpingすると
  // スリープを回避できる（月750時間の無料枠内に収まる想定。詳細はDEPLOY.md参照）。
  app.get('/health', (req, res) => {
    res.status(200).send('ok');
  });

  // 公開鍵を配布するエンドポイント
  app.get('/api/vapid-public-key', (req, res) => {
    res.json({ publicKey: vapidKeys.publicKey });
  });

  // 店長の自己登録：店舗名を入力するだけで新しい店舗が作られ、管理者キーが発行される。
  // 管理者キーはこのレスポンスでしか平文を返さない（DBにはハッシュ値のみ保存）。
  app.post('/api/stores', async (req, res) => {
    const name = ((req.body && req.body.name) || '').trim();
    if (!name) {
      return res.status(400).json({ error: '店舗名を入力してください' });
    }
    if (name.length > 100) {
      return res.status(400).json({ error: '店舗名が長すぎます' });
    }
    try {
      const adminKey = generateAdminKey();
      const { data: store, error } = await supabase
        .from('stores')
        .insert({ name, admin_key_hash: hashKey(adminKey) })
        .select()
        .single();
      if (error) throw error;

      res.status(201).json({ storeId: store.id, storeName: store.name, adminKey });
    } catch (err) {
      console.error('create store error:', err);
      res.status(500).json({ error: '店舗の作成に失敗しました' });
    }
  });

  // 店舗名を表示用に取得する（スタッフ登録画面が、リンク先の店舗名を確認するために使う）。
  // 管理者キーなどの秘匿情報は一切含まない。
  app.get('/api/stores/:id', async (req, res) => {
    const { data, error } = await supabase.from('stores').select('id, name').eq('id', req.params.id).maybeSingle();
    if (error) {
      console.error('get store error:', error);
      return res.status(500).json({ error: '取得に失敗しました' });
    }
    if (!data) return res.status(404).json({ error: '店舗が見つかりません' });
    res.json({ id: data.id, name: data.name });
  });

  // ログイン中の店長の店舗情報を返す（管理者キーに紐づく店舗）
  app.get('/api/me', requireAdmin, (req, res) => {
    res.json({ storeId: req.storeId, storeName: req.storeName });
  });

  // スタッフの通知宛先(Subscription)を保存。どの店舗・誰の登録かも一緒に記録する。
  // store_idは店長から配られたリンク/QRコードのURL(?store=店舗ID)から来るため、
  // 店舗名が他店と被っていても間違った店舗に登録される心配がない。
  // 名前は仮名で構わないが、応募時のなりすまし防止のため必須にしている。
  app.post('/api/subscribe', async (req, res) => {
    const { subscription, store_id, staff_name } = req.body || {};
    const name = (staff_name || '').trim();
    if (!subscription || !subscription.endpoint) {
      return res.status(400).json({ error: '不正なリクエストです' });
    }
    if (!store_id) {
      return res.status(400).json({ error: '店舗のリンクが正しくありません' });
    }
    if (!name) {
      return res.status(400).json({ error: 'お名前（仮名でも可）を入力してください' });
    }
    try {
      const { data: store, error: storeErr } = await supabase
        .from('stores')
        .select('id, name')
        .eq('id', store_id)
        .maybeSingle();
      if (storeErr) throw storeErr;
      if (!store) return res.status(400).json({ error: '店舗が見つかりません（リンクが正しいか確認してください）' });

      const { data: existing, error: selErr } = await supabase
        .from('subscriptions')
        .select('id')
        .eq('endpoint', subscription.endpoint)
        .maybeSingle();
      if (selErr) throw selErr;

      if (!existing) {
        const { error: insErr } = await supabase
          .from('subscriptions')
          .insert({ endpoint: subscription.endpoint, subscription, store_id: store.id, store_name: store.name, staff_name: name });
        if (insErr) throw insErr;
      } else {
        // 既に登録済みの端末が店舗や名前を選び直した場合は上書きする
        const { error: updErr } = await supabase
          .from('subscriptions')
          .update({ store_id: store.id, store_name: store.name, staff_name: name })
          .eq('endpoint', subscription.endpoint);
        if (updErr) throw updErr;
      }

      const { count, error: countErr } = await supabase
        .from('subscriptions')
        .select('*', { count: 'exact', head: true })
        .eq('store_id', store.id);
      if (countErr) throw countErr;

      res.status(201).json({ message: `${store.name}のスタッフ「${name}」として宛先を保存しました`, count });
    } catch (err) {
      console.error('subscribe error:', err);
      res.status(500).json({ error: '宛先の保存に失敗しました' });
    }
  });

  // 店長：ヘルプ募集を自分の店舗のスタッフに配信
  // 店舗はリクエストボディからではなく、ログインに使った管理者キーから決まる。
  // これにより、ある店舗のキーでログインした店長が他店舗へ誤配信することはできない。
  app.post('/api/send-broadcast', requireAdmin, async (req, res) => {
    const storeId = req.storeId;
    const storeName = req.storeName;
    const { date, time, note } = req.body;
    if (!date || !time) {
      return res.status(400).json({ error: '日付・時間は必須です' });
    }

    try {
      const { data: shift, error: insErr } = await supabase
        .from('shifts')
        .insert({ store_id: storeId, store_name: storeName, date, time, note: note || '' })
        .select()
        .single();
      if (insErr) throw insErr;

      const shiftId = shift.id;
      // APP_URLを明示指定していなければ、Renderが自動で用意するURLを使う
      const baseUrl = process.env.APP_URL || process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;
      const payload = JSON.stringify({
        title: `🚨【急募】${storeName}`,
        body: `【日時】${date} ${time}${note ? '\n' + note : ''}\n先着1名です。タップして応募！`,
        url: `${baseUrl}/respond.html?id=${shiftId}`,
      });

      // 同じ店舗を選んで登録したスタッフだけに送る（他店舗には届かない）
      const { data: subs, error: subsErr } = await supabase
        .from('subscriptions')
        .select('*')
        .eq('store_id', storeId);
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

  // スタッフ：募集の現在の状態を確認（respond.html用）
  // 応募時になりすましを防ぐため、その店舗に登録済みのスタッフ名一覧も一緒に返す。
  app.get('/api/shift/:id', async (req, res) => {
    const { data, error } = await supabase.from('shifts').select('*').eq('id', req.params.id).maybeSingle();
    if (error) {
      console.error('get shift error:', error);
      return res.status(500).json({ error: '取得に失敗しました' });
    }
    if (!data) return res.status(404).json({ error: '募集が見つかりません' });

    const { data: staffRows, error: staffErr } = await supabase
      .from('subscriptions')
      .select('staff_name')
      .eq('store_id', data.store_id);
    if (staffErr) {
      console.error('get staff error:', staffErr);
      return res.status(500).json({ error: '取得に失敗しました' });
    }
    const staffNames = Array.from(new Set((staffRows || []).map((r) => r.staff_name).filter(Boolean)));

    res.json({ ...mapShift(data), staffNames });
  });

  // スタッフ：先着順で応募する
  // UPDATE ... WHERE status = 'open' を使うことで、複数人が同時に応募しても
  // Postgres側で1件しか更新が成功しない（先着順が保証される）。
  // 応募前に「その店舗に登録済みの名前かどうか」を確認し、なりすまし応募を防ぐ。
  app.post('/api/shift/:id/respond', async (req, res) => {
    try {
      const name = (req.body && req.body.name ? String(req.body.name) : '').trim();
      if (!name) {
        return res.status(400).json({ error: 'お名前を選択してください' });
      }

      const { data: shift, error: shiftErr } = await supabase
        .from('shifts')
        .select('*')
        .eq('id', req.params.id)
        .maybeSingle();
      if (shiftErr) throw shiftErr;
      if (!shift) return res.status(404).json({ error: '募集が見つかりません' });

      const { data: staffRows, error: staffErr } = await supabase
        .from('subscriptions')
        .select('staff_name')
        .eq('store_id', shift.store_id)
        .eq('staff_name', name);
      if (staffErr) throw staffErr;
      if (!staffRows || !staffRows.length) {
        return res.status(403).json({ error: 'その店舗に登録されている名前を選んでください' });
      }

      const { data, error } = await supabase
        .from('shifts')
        .update({
          status: 'filled',
          filled_by: name,
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

      // 更新が0件だった場合：応募している間にすでに他の人が埋めていた
      return res.status(409).json({ error: '残念、すでに他のスタッフが対応済みです', shift: mapShift(shift) });
    } catch (err) {
      console.error('respond error:', err);
      res.status(500).json({ error: '応募処理に失敗しました' });
    }
  });

  // 店長：募集一覧（ダッシュボード用）。自分の店舗の分だけを返す。
  app.get('/api/shifts', requireAdmin, async (req, res) => {
    const { data, error } = await supabase
      .from('shifts')
      .select('*')
      .eq('store_id', req.storeId)
      .order('created_at', { ascending: false });
    if (error) {
      console.error('list shifts error:', error);
      return res.status(500).json({ error: '取得に失敗しました' });
    }
    res.json((data || []).map(mapShift));
  });

  // 店長：自分の店舗に登録済みのスタッフ一覧（誰が登録しているか確認できるように）
  app.get('/api/staff', requireAdmin, async (req, res) => {
    const { data, error } = await supabase
      .from('subscriptions')
      .select('staff_name, registered_at')
      .eq('store_id', req.storeId)
      .order('registered_at', { ascending: false });
    if (error) {
      console.error('list staff error:', error);
      return res.status(500).json({ error: '取得に失敗しました' });
    }
    res.json((data || []).map((r) => ({ staffName: r.staff_name, registeredAt: r.registered_at })));
  });

  app.listen(PORT, () => console.log(`Server running: http://localhost:${PORT}`));
}

main().catch((err) => {
  console.error('起動に失敗しました:', err);
  process.exit(1);
});
