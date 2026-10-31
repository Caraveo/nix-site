import { HttpError } from "./validate.js";

export async function fingerprint(value) {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, "0")).join("");
}

// A D1 batch is a transaction. The random owner prevents duplicate requests
// from decrementing the balance or inserting the debit twice.
export async function reserve(db, subscription, key, requestHash, now = Date.now()) {
  const id = await fingerprint(`${subscription}\0${key}`);
  const owner = crypto.randomUUID();
  await db.batch([
    db.prepare(`INSERT INTO pioneer_calls
      (id, subscription_id, request_hash, owner, status, cost, created_at, updated_at)
      SELECT ?, id, ?, ?, 'pending', 1, ?, ? FROM subscriptions
      WHERE id = ? AND units >= 1 AND paid_through > ?
      AND status IN ('active', 'cancelled') ON CONFLICT(id) DO NOTHING`)
      .bind(id, requestHash, owner, now, now, subscription, now),
    db.prepare(`UPDATE subscriptions SET units = units - 1, updated_at = ?
      WHERE id = ? AND EXISTS (SELECT 1 FROM pioneer_calls WHERE id = ? AND owner = ?)`)
      .bind(now, subscription, id, owner),
    db.prepare(`INSERT INTO unit_ledger
      (id, subscription_id, delta, reason, balance_after, created_at)
      SELECT ?, id, -1, 'pioneer', units, ? FROM subscriptions WHERE id = ?
      AND EXISTS (SELECT 1 FROM pioneer_calls WHERE id = ? AND owner = ?)`)
      .bind(`pioneer:${id}`, now, subscription, id, owner),
  ]);
  const call = await db.prepare("SELECT * FROM pioneer_calls WHERE id = ? AND subscription_id = ?")
    .bind(id, subscription).first();
  if (!call) throw new HttpError(402, "credits_required");
  if (call.request_hash !== requestHash) throw new HttpError(409, "idempotency_conflict");
  if (call.status === "complete") {
    if (!call.response_json) throw new HttpError(409, "idempotency_key_expired");
    return { id, cached: JSON.parse(call.response_json) };
  }
  if (call.owner !== owner) throw new HttpError(409,
    call.status === "failed" ? "request_failed_use_new_id" : "request_in_progress");
  return { id, owner };
}

export async function complete(db, reservation, response, now = Date.now()) {
  const result = await db.prepare(`UPDATE pioneer_calls SET status = 'complete',
    response_json = ?, updated_at = ? WHERE id = ? AND owner = ? AND status = 'pending'`)
    .bind(JSON.stringify(response), now, reservation.id, reservation.owner).run();
  if (result.meta.changes !== 1) throw new Error("Pioneer reservation lost");
}

export async function refund(db, reservation, now = Date.now()) {
  const nonce = crypto.randomUUID();
  const results = await db.batch([
    db.prepare(`UPDATE pioneer_calls SET status = 'failed', refund_owner = ?, updated_at = ?
      WHERE id = ? AND owner = ? AND status = 'pending'`)
      .bind(nonce, now, reservation.id, reservation.owner),
    db.prepare(`UPDATE subscriptions SET units = units + 1, updated_at = ?
      WHERE id = (SELECT subscription_id FROM pioneer_calls WHERE id = ? AND refund_owner = ?)`)
      .bind(now, reservation.id, nonce),
    db.prepare(`INSERT INTO unit_ledger
      (id, subscription_id, delta, reason, balance_after, created_at)
      SELECT ?, id, 1, 'pioneer_refund', units, ? FROM subscriptions
      WHERE id = (SELECT subscription_id FROM pioneer_calls WHERE id = ? AND refund_owner = ?)`)
      .bind(`pioneer-refund:${reservation.id}`, now, reservation.id, nonce),
  ]);
  return results[0].meta.changes === 1;
}
