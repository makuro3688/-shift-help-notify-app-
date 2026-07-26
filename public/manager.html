// サーバーからプッシュ電波を受信した時の処理
self.addEventListener('push', (event) => {
  const data = event.data.json();

  const options = {
    body: data.body,
    icon: '/icon.png', // 通知に表示するお店のアイコン画像（任意。無くてもエラーにはならない）
    badge: '/badge.png',
    vibrate: [200, 100, 200], // スマホをブブッと震わせる
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
