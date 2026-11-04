# MenuMind API – setup

Uses the existing Supabase tables (no schema changes):
pos_import_batches, raw_pos_sales_records, platform_payout_reconciliation,
restaurants, restaurant_outlets, restaurant_users.

1. Create `.env` in this folder:
   PORT=4000
   CORS_ORIGINS=http://localhost:3000
   SUPABASE_URL=https://<project-ref>.supabase.co
   SUPABASE_ANON_KEY=sb_publishable_...
   SUPABASE_SERVICE_ROLE_KEY=sb_secret_...
2. npm install
3. npm start   → "MenuMind API listening on port 4000"
