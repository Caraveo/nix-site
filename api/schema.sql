CREATE TABLE IF NOT EXISTS subscriptions (
  id TEXT PRIMARY KEY,
  device_hash TEXT NOT NULL,
  idempotency_hash TEXT NOT NULL UNIQUE,
  authnet_subscription_id TEXT,
  authnet_customer_profile_id TEXT,
  authnet_payment_profile_id TEXT,
  authnet_transaction_id TEXT,
  card_brand TEXT,
  card_last4 TEXT,
  status TEXT NOT NULL,
  plan TEXT NOT NULL DEFAULT 'month',
  amount TEXT NOT NULL DEFAULT '2.99',
  renewal_scheduled INTEGER NOT NULL DEFAULT 0,
  paid_through INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  cancelled_at INTEGER,
  gateway_note TEXT,
  units INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS tokens (
  token_hash TEXT PRIMARY KEY,
  subscription_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  expires_at INTEGER,
  created_at INTEGER NOT NULL,
  revoked_at INTEGER,
  last_used_at INTEGER
);

CREATE TABLE IF NOT EXISTS payments (
  id TEXT PRIMARY KEY,
  subscription_id TEXT,
  authnet_trans_id TEXT,
  amount TEXT,
  kind TEXT NOT NULL,
  received_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS rate_limits (
  bucket TEXT PRIMARY KEY,
  hits INTEGER NOT NULL,
  reset_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_tokens_sub ON tokens (subscription_id, kind);
CREATE INDEX IF NOT EXISTS idx_sub_device ON subscriptions (device_hash, status);
CREATE INDEX IF NOT EXISTS idx_sub_authnet ON subscriptions (authnet_subscription_id);
CREATE INDEX IF NOT EXISTS idx_pay_trans ON payments (authnet_trans_id);

CREATE TABLE IF NOT EXISTS unit_ledger (
  id TEXT PRIMARY KEY,
  subscription_id TEXT NOT NULL,
  delta INTEGER NOT NULL,
  reason TEXT NOT NULL,
  balance_after INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS unit_purchases (
  id TEXT PRIMARY KEY,
  idempotency_hash TEXT NOT NULL UNIQUE,
  subscription_id TEXT NOT NULL,
  pack TEXT NOT NULL,
  units INTEGER NOT NULL,
  amount TEXT NOT NULL,
  authnet_trans_id TEXT,
  status TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS intent_calls (
  idempotency_hash TEXT PRIMARY KEY,
  subscription_id TEXT NOT NULL,
  intent TEXT NOT NULL,
  cost INTEGER NOT NULL,
  response_json TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
