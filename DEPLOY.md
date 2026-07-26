PORT=3000

# 店長用ダッシュボード(manager.html)の合言葉。必ず変更してください
ADMIN_KEY=please-change-this-to-something-secret

# web-pushの規約上必要な連絡先（実際に受信できるアドレスでなくてもよい）
VAPID_CONTACT_EMAIL=your-email@example.com

# 本番公開時のURL。Render上で動かす場合は空でよい（RENDER_EXTERNAL_URLを自動使用）
APP_URL=

# SupabaseのProject Settings > API から取得
# URLは「Project URL」、KEYは「service_role」キー（anonキーではない点に注意。secretなので絶対に公開しない）
SUPABASE_URL=https://xxxxxxxxxxxx.supabase.co
SUPABASE_SERVICE_KEY=your-service-role-key
