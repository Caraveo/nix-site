CREATE TABLE IF NOT EXISTS pioneer_calls (
  id TEXT PRIMARY KEY,
  subscription_id TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  owner TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'complete', 'failed')),
  cost INTEGER NOT NULL CHECK (cost = 1),
  response_json TEXT,
  refund_owner TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pioneer_subscription ON pioneer_calls(subscription_id, created_at);
