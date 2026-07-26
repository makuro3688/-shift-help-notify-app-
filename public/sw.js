<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>ヘルプ通知登録</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, "Hiragino Sans", sans-serif; background: #f4f6f9; padding: 20px; text-align: center; }
  .card { background: white; padding: 30px; border-radius: 12px; box-shadow: 0 4px 10px rgba(0,0,0,0.05); max-width: 400px; margin: 40px auto; }
  button { background: #00a8ff; color: white; border: none; padding: 16px; width: 100%; border-radius: 8px; font-size: 16px; font-weight: bold; cursor: pointer; margin-top: 20px; }
  button:disabled { background: #b0c4d4; }
  .note { color: #7f8c8d; font-size: 13px; margin-top: 16px; line-height: 1.6; }
  .status { margin-top: 16px; font-size: 14px; }
</style>
</head>
<body>

<div class="card">
  <h2>🤝 ヘルプ通知センター</h2>
  <p style="color:#7f8c8d; font-size:14px; margin-top:10px;">LINEも個人情報も不要です。下のボタンを押して通知を許可してください。</p>
  <button id="registerBtn" onclick="enablePushNotification()">🔔 通知を許可して登録</button>
  <div id="status" class="status"></div>
  <p class="note">
    iPhoneの方へ：Safariで開いた後、共有ボタン→「ホーム画面に追加」してから、ホーム画面のアイコンで開いて登録してください（Safariのタブのままだと通知が許可できません）。
  </p>
</div>

<script>
function setStatus(msg) {
  document.getElementById('status').textContent = msg;
}

async function enablePushNotification() {
  const btn = document.getElementById('registerBtn');
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
    setStatus('お使いのブラウザはプッシュ通知に対応していません。(iPhoneの場合はホーム画面に追加してから開いてください)');
    return;
  }

  btn.disabled = true;
  try {
    const register = await navigator.serviceWorker.register('/sw.js');

    const permission = await Notification.requestPermission();
    if (permission !== 'granted') {
      setStatus('通知が拒否されました。ブラウザの設定から許可してください。');
      btn.disabled = false;
      return;
    }

    const { publicKey } = await fetch('/api/vapid-public-key').then((r) => r.json());

    const subscription = await register.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(publicKey),
    });

    await fetch('/api/subscribe', {
      method: 'POST',
      body: JSON.stringify(subscription),
      headers: { 'Content-Type': 'application/json' },
    });

    setStatus('✅ 通知登録が完了しました！この画面は閉じてOKです。');
  } catch (err) {
    console.error(err);
    setStatus('登録中にエラーが発生しました：' + err.message);
    btn.disabled = false;
  }
}

function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = window.atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; ++i) outputArray[i] = rawData.charCodeAt(i);
  return outputArray;
}
</script>
</body>
</html>
