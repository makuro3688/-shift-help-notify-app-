// サーバーからプッシュ電波を受信した時の処理
self.addEventListener('push', (event) => {
  const data = event.data.json();

  // 【確定通知の拡張】サーバー側(server.js)は、通知の種類に応じてペイロードに
  // vibrateを明示的に含めることがある（例：「募集は終了しました」は震動なし＝空配列で
  // 送られてくる。急募・確定など見逃されて困る通知は[200,100,200]で送られてくる）。
  // data.vibrateが指定されていればそれを優先し、指定が無い場合（従来どおりの急募配信など）は
  // 従来どおりのデフォルト（震動あり）にフォールバックする。これにより、既存の配信処理
  // （vibrateを含めずに送ってくる/api/send-broadcast）の挙動は変えずに、新しい通知種別だけ
  // 震動の強さを使い分けられるようにしている。
  const options = {
    body: data.body,
    icon: '/icon.png', // 通知に表示するお店のアイコン画像（任意。無くてもエラーにはならない）
    badge: '/badge.png',
    vibrate: data.vibrate !== undefined ? data.vibrate : [200, 100, 200], // スマホをブブッと震わせる（種類により震動なしもあり）
    data: { url: data.url }, // 通知をタップした時のジャンプ先URL
  };

  event.waitUntil(self.registration.showNotification(data.title, options));
});

// スタッフが通知をタップした時の処理
self.addEventListener('notificationclick', (event) => {
  event.notification.close(); // 通知を閉じる

  // 指定された回答画面（使い捨てURL）をブラウザで開く
  event.waitUntil(clients.openWindow(event.notification.data.url));
});
