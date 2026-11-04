# MenuMind API

Ingestion API for MenuMind AI. Same layout as the Bongo Delicacy API (`loaders/`, `config/`, `middleware/`, `api/{routes,controllers,services,helpers,validations}`), scoped to two jobs:

1. **Upload POS sales data**: Petpooja item-wise / highest-selling reports and any other POS export (.xlsx / .xls / .csv)
2. **Upload Swiggy, Zomato & Ownly payout statements**, store them, and **match revenue** against POS sales

Every file is parsed on the server and written to Supabase Postgres. Nothing is estimated or filled with default values. If something can't be detected (platform, month, required columns), the API returns `422` with what's missing.

## Setup

```bash
npm install
cp .env.example .env        # fill SUPABASE_URL / keys / CORS_ORIGINS
# run db/migrations/001_menumind_uploads.sql in the Supabase SQL editor
npm start                   # or: npm run dev
npm test                    # parser tests
```

Users sign in with Supabase Auth email/password. Create them in **Supabase → Authentication → Users** (there is no public sign-up endpoint).

`xlsx` is installed from the official SheetJS CDN (0.20.3). The npm registry copy (0.18.5) has known prototype-pollution and ReDoS advisories.

## Endpoints

All routes except `/health`, `/api/auth/login` and `/api/auth/refresh` need `Authorization: Bearer <accessToken>`.

| Method | Path | Notes |
|---|---|---|
| POST | `/api/auth/login` | `{ email, password }` → `{ accessToken, refreshToken, expiresAt, user }` |
| POST | `/api/auth/refresh` | `{ refreshToken }` |
| GET | `/api/auth/me` | |
| POST | `/api/auth/logout` | |
| POST | `/api/pos-sales/upload` | multipart: `files[]`, optional `presetId`, `layout` (JSON), `mapping` / `mappings` (JSON, keyed by file name), `outletOverrides` (JSON), `defaultOutlet`, `posSystem`, `replace` |
| GET | `/api/pos-sales/records` | `from, to, outlet, channel, batchId, includeReturns, page, perPage≤5000` |
| GET | `/api/pos-sales/batches` | upload history |
| DELETE | `/api/pos-sales/batches/:id` | removes the file and its rows |
| POST | `/api/payouts/upload` | multipart: `files[]`, optional `platform`, `outletId`, `month` (YYYY-MM), `periodType`, `weekLabel`, `replace` |
| GET | `/api/payouts` | `month, fromMonth, toMonth, outletId, platform, page, perPage` |
| GET | `/api/payouts/batches` | upload history |
| DELETE | `/api/payouts/batches/:id` | |
| GET | `/api/payouts/reconciliation` | `month` (required), `outletId` → POS vs aggregator match per channel |

### Behaviour

- **All-or-nothing:** every file in a request is parsed before anything is written. If a DB write fails, all batches from that request are rolled back and kept as `failed` for audit.
- **Duplicates:** files are fingerprinted with SHA-256. Re-uploading the same file returns `409` unless `replace=true`. POS rows are de-duplicated per user by row signature. Payout orders are de-duplicated per user, platform and order ID, so overlapping weekly and monthly statements are only counted once.
- **POS layout:** uses `layout`/`presetId` when given. Otherwise it auto-detects the header row. Column mapping is auto-detected, and anything you send in `mapping` overrides it.
- **Payout parsing:** scans every sheet for the best header row (order-level tables) and falls back to vertical "Label | Value" summaries. CGST/SGST-on-fee columns are summed. Deductions are stored as positive amounts.
- **Settlement status:** `calculated = (gross − discounts) − (commission + PG + ads + cancellation + other + GST on fees + TCS + TDS + Hyperpure)`. The status is `reconciled` when it is within ₹1 of the statement's net payout, `discrepancy` otherwise, and `pending` when the statement has no net payout column.
- **Revenue match:** `matched` ≤ 2 % variance, `minor_variance` ≤ 5 %, otherwise `unmatched` (set in `config/constant.js`).
- Security: helmet, CORS allow-list, rate limits (API, login, upload), 20 MB per file / 10 files, extension allow-list, Joi validation, RLS on every table (owner read-only; writes only through the API's service role).
