import { cancelSubscription, chargeOpaque, createSubscription, profileFromTransaction, transactionSubscriptionId } from "./authnet.js";
import { cipherMac, sealToken, tokenMac } from "./cipher.js";
import { publicPacks, requirePack } from "./units.js";
import { publicIntents, serveIntent } from "./intents.js";
import { paidUntil, planById, planFromToken, publicPlans, requirePlan, showExpiry } from "./plans.js";
import { PERIOD_MS, PRICE, arbStartDate, mintToken, tokenHash, webhookSignatureValid } from "./token.js";
import {
  HttpError,
  optionalCountry,
  rejectCardFields,
  requireDeviceId,
  requireIdempotencyKey,
  requireName,
  requireOpaqueData,
  requirePostal,
} from "./validate.js";

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "strict-transport-security": "max-age=31536000",
    },
  });
}

function requireConfig(env) {
  if (!env.DB || !/^[0-9a-fA-F]{64}$/.test(env.TOKEN_PEPPER || "")) {
    throw new HttpError(500, "misconfigured");
  }
  if (!env.AUTHNET_API_LOGIN_ID || !env.AUTHNET_TRANSACTION_KEY || !/^[0-9a-fA-F]{128}$/.test(env.AUTHNET_SIGNATURE_KEY || "")) {
    throw new HttpError(500, "misconfigured");
  }
}

async function readBody(request) {
  const type = request.headers.get("content-type") || "";
  if (!type.includes("application/json")) throw new HttpError(415, "json_required");
  const text = await request.text();
  if (text.length > 20000) throw new HttpError(413, "body_too_large");
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new HttpError(400, "invalid_json");
  }
  rejectCardFields(body);
  return body;
}

function bearer(request) {
  const match = /^Bearer (\S+)$/.exec(request.headers.get("authorization") || "");
  if (!match || !planFromToken(match[1])) throw new HttpError(401, "invalid_or_expired");
  return match[1];
}

async function limit(env, request, route, max, windowMs) {
  const ip = request.headers.get("cf-connecting-ip") || "unknown";
  const window = Math.floor(Date.now() / windowMs);
  const bucket = await tokenHash(env.TOKEN_PEPPER, `${route}:${ip}:${window}`);
  const now = Date.now();
  const row = await env.DB.prepare("SELECT hits, reset_at FROM rate_limits WHERE bucket = ?").bind(bucket).first();
  if (!row || row.reset_at < now) {
    await env.DB.prepare(
      "INSERT INTO rate_limits (bucket, hits, reset_at) VALUES (?, 1, ?) ON CONFLICT(bucket) DO UPDATE SET hits = 1, reset_at = excluded.reset_at",
    ).bind(bucket, now + windowMs).run();
    return;
  }
  if (row.hits >= max) throw new HttpError(429, "rate_limited");
  await env.DB.prepare("UPDATE rate_limits SET hits = hits + 1 WHERE bucket = ?").bind(bucket).run();
}

async function digestToken(env, kind, token) {
  const plan = planFromToken(token);
  if (!plan) throw new HttpError(401, "invalid_or_expired");
  const hash = await tokenMac(env.TOKEN_PEPPER, plan, kind, token);
  if (!hash) throw new HttpError(401, "invalid_or_expired");
  return hash;
}

async function minted(env, plan, kind) {
  if (plan.prefix) {
    const token = await sealToken(env.TOKEN_PEPPER, plan, kind);
    return { token, hash: await cipherMac(env.TOKEN_PEPPER, plan, `${kind}:${token}`) };
  }
  const token = mintToken();
  return { token, hash: await tokenHash(env.TOKEN_PEPPER, `${kind}:${token}`) };
}

async function issuePair(env, subscriptionId, plan, expiresAt) {
  const access = await minted(env, plan, "access");
  const refresh = await minted(env, plan, "refresh");
  const now = Date.now();
  await env.DB.prepare(
    "INSERT INTO tokens (token_hash, subscription_id, kind, expires_at, created_at) VALUES (?, ?, 'access', ?, ?)",
  ).bind(access.hash, subscriptionId, expiresAt, now).run();
  await env.DB.prepare(
    "INSERT INTO tokens (token_hash, subscription_id, kind, expires_at, created_at) VALUES (?, ?, 'refresh', NULL, ?)",
  ).bind(refresh.hash, subscriptionId, now).run();
  return { access: access.token, refresh: refresh.token };
}

async function revokeKind(env, subscriptionId, kind) {
  await env.DB.prepare(
    "UPDATE tokens SET revoked_at = ? WHERE subscription_id = ? AND kind = ? AND revoked_at IS NULL",
  ).bind(Date.now(), subscriptionId, kind).run();
}

function tokenPayload(sub, plan, tokens, renewal, card, statusCode, upgradeNote) {
  const body = {
    subscription_id: sub.id,
    status: sub.status || "active",
    plan: plan.id,
    command: "ask",
    amount: plan.amount,
    currency: "USD",
    interval_days: plan.days,
    lifetime: !plan.days,
    cipher: plan.cipher,
    paid_through: showExpiry(plan, sub.paid_through),
    renewal_scheduled: renewal,
    access_token: tokens.access,
    refresh_token: tokens.refresh,
    access_expires_at: showExpiry(plan, sub.paid_through),
    token_type: "Bearer",
    card,
  };
  if (upgradeNote) body.prior_renewal = "cancel_failed";
  if (String(sub.authnet_transaction_id || "").startsWith("test:")) body.test_mode = true;
  if (typeof sub.units === "number") body.units = sub.units;
  return json(body, statusCode);
}

async function retirePrior(env, deviceHash, keepId) {
  const result = await env.DB.prepare(
    `SELECT id, authnet_subscription_id FROM subscriptions
     WHERE device_hash = ? AND id != ? AND status IN ('active', 'cancelled') AND paid_through > ?`,
  ).bind(deviceHash, keepId, Date.now()).all();
  let note = "";
  for (const prior of result.results || []) {
    if (prior.authnet_subscription_id) {
      try {
        await cancelSubscription(env, prior.authnet_subscription_id);
      } catch {
        note = "prior_renewal_cancel_failed";
      }
    }
    await env.DB.prepare(
      "UPDATE subscriptions SET status = 'superseded', renewal_scheduled = 0, updated_at = ? WHERE id = ?",
    ).bind(Date.now(), prior.id).run();
    await revokeKind(env, prior.id, "access");
    await revokeKind(env, prior.id, "refresh");
  }
  return note;
}

async function resume(env, sub, deviceHash) {
  if (sub.device_hash !== deviceHash) throw new HttpError(409, "idempotency_device_mismatch");
  if (sub.status === "charging") throw new HttpError(409, "payment_in_progress", { reference: sub.id });
  if (sub.status !== "active" && sub.status !== "cancelled") {
    throw new HttpError(409, "use_new_idempotency_key", { reference: sub.id });
  }
  const plan = planById(sub.plan || "month");
  const used = await env.DB.prepare(
    "SELECT 1 AS hit FROM tokens WHERE subscription_id = ? AND last_used_at IS NOT NULL LIMIT 1",
  ).bind(sub.id).first();
  if (used) {
    throw new HttpError(409, "subscription_exists", { paid_through: showExpiry(plan, sub.paid_through), plan: plan.id });
  }
  const upgradeNote = await retirePrior(env, sub.device_hash, sub.id);
  sub.units = await grantIncluded(env, sub.id, plan);
  await revokeKind(env, sub.id, "access");
  await revokeKind(env, sub.id, "refresh");
  const tokens = await issuePair(env, sub.id, plan, sub.paid_through);
  return tokenPayload(
    sub,
    plan,
    tokens,
    Boolean(sub.renewal_scheduled),
    { brand: sub.card_brand || "", last4: sub.card_last4 || "" },
    200,
    upgradeNote,
  );
}

async function subscribe(request, env) {
  requireConfig(env);
  const origin = request.headers.get("origin");
  if (origin && origin !== "null") throw new HttpError(403, "purchase_inside_nix_only");
  const body = await readBody(request);
  const deviceId = requireDeviceId(body.device_id);
  const idempotencyKey = requireIdempotencyKey(request.headers.get("idempotency-key"));
  const opaque = requireOpaqueData(body);
  const plan = requirePlan(body.plan);
  const billTo = {
    firstName: requireName(body.bill_to?.first_name, "first_name_required"),
    lastName: requireName(body.bill_to?.last_name, "last_name_required"),
    zip: requirePostal(body.bill_to?.zip || body.bill_to?.postal_code),
    country: optionalCountry(body.bill_to?.country),
  };
  await limit(env, request, "subscribe", 8, 60 * 60 * 1000);
  const deviceHash = await tokenHash(env.TOKEN_PEPPER, `device:${deviceId}`);
  const idempotencyHash = await tokenHash(env.TOKEN_PEPPER, `idem:${idempotencyKey}`);
  const current = await env.DB.prepare(
    `SELECT id, paid_through, plan FROM subscriptions
     WHERE device_hash = ? AND status IN ('active', 'cancelled') AND paid_through > ?
     ORDER BY paid_through DESC LIMIT 1`,
  ).bind(deviceHash, Date.now()).first();
  if (current) {
    const currentPlan = planById(current.plan || "month");
    if (plan.rank <= currentPlan.rank) {
      throw new HttpError(409, "already_subscribed", {
        plan: currentPlan.id,
        paid_through: showExpiry(currentPlan, current.paid_through),
      });
    }
  }

  const prior = await env.DB.prepare("SELECT * FROM subscriptions WHERE idempotency_hash = ?").bind(idempotencyHash).first();
  if (prior) return resume(env, prior, deviceHash);

  const id = crypto.randomUUID();
  const now = Date.now();
  const refId = id.replaceAll("-", "").slice(0, 20);
  await env.DB.prepare(
    `INSERT INTO subscriptions (
      id, device_hash, idempotency_hash, status, plan, amount, renewal_scheduled, paid_through, created_at, updated_at
    ) VALUES (?, ?, ?, 'charging', ?, ?, 0, 0, ?, ?)`,
  ).bind(id, deviceHash, idempotencyHash, plan.id, plan.amount, now, now).run();

  let charge;
  try {
    charge = await chargeOpaque(env, {
      refId,
      opaque,
      billTo,
      customerId: refId,
      amount: plan.amount,
      description: plan.id === "month" ? "NIX ask" : `NIX ask ${plan.id}`,
    });
  } catch (err) {
    const code = err instanceof HttpError ? err.code : "payment_declined";
    await env.DB.prepare(
      "UPDATE subscriptions SET status = ?, updated_at = ?, gateway_note = ? WHERE id = ?",
    ).bind(code === "payment_unconfirmed" ? "review" : "failed", Date.now(), code, id).run();
    if (err instanceof HttpError) err.extra = { ...err.extra, reference: id };
    throw err;
  }

  const paidThrough = paidUntil(plan, now);
  await env.DB.prepare(
    `UPDATE subscriptions
     SET status = 'active', authnet_transaction_id = ?, card_brand = ?, card_last4 = ?,
         paid_through = ?, updated_at = ?
     WHERE id = ?`,
  ).bind(charge.transId, charge.brand, charge.last4, paidThrough, Date.now(), id).run();
  await env.DB.prepare(
    "INSERT INTO payments (id, subscription_id, authnet_trans_id, amount, kind, received_at) VALUES (?, ?, ?, ?, 'initial', ?)",
  ).bind(charge.transId, id, charge.transId, charge.amount, Date.now()).run();

  let renewal = false;
  if (plan.recurring && !charge.testMode) {
    try {
      const profile = await profileFromTransaction(env, charge.transId);
      if (profile) {
        const created = await createSubscription(env, { refId, profile, startDate: arbStartDate(now) });
        renewal = Boolean(created.id);
        await env.DB.prepare(
          `UPDATE subscriptions
           SET authnet_customer_profile_id = ?, authnet_payment_profile_id = ?,
               authnet_subscription_id = ?, renewal_scheduled = ?, gateway_note = ?, updated_at = ?
           WHERE id = ?`,
        ).bind(
          profile.customerProfileId,
          profile.paymentProfileId,
          created.id || null,
          renewal ? 1 : 0,
          created.note || null,
          Date.now(),
          id,
        ).run();
      }
    } catch {
      await env.DB.prepare(
        "UPDATE subscriptions SET gateway_note = 'renewal_not_scheduled', updated_at = ? WHERE id = ?",
      ).bind(Date.now(), id).run();
    }
  }

  const upgradeNote = await retirePrior(env, deviceHash, id);
  if (upgradeNote) {
    await env.DB.prepare(
      "UPDATE subscriptions SET gateway_note = ?, updated_at = ? WHERE id = ?",
    ).bind(upgradeNote, Date.now(), id).run();
  }

  const sub = { id, status: "active", paid_through: paidThrough, authnet_transaction_id: charge.transId };
  sub.units = await grantIncluded(env, id, plan);
  const tokens = await issuePair(env, id, plan, paidThrough);
  return tokenPayload(sub, plan, tokens, renewal, { brand: charge.brand, last4: charge.last4 }, 201, upgradeNote);
}

async function loadRefresh(request, env) {
  requireConfig(env);
  await limit(env, request, "refresh", 30, 60 * 1000);
  const token = bearer(request);
  const body = await readBody(request);
  const deviceHash = await tokenHash(env.TOKEN_PEPPER, `device:${requireDeviceId(body.device_id)}`);
  const hash = await digestToken(env, "refresh", token);
  const row = await env.DB.prepare(
    `SELECT t.revoked_at, s.*
     FROM tokens t JOIN subscriptions s ON s.id = t.subscription_id
     WHERE t.token_hash = ? AND t.kind = 'refresh'`,
  ).bind(hash).first();
  if (!row || row.revoked_at || row.device_hash !== deviceHash) throw new HttpError(401, "invalid_or_expired");
  await env.DB.prepare("UPDATE tokens SET last_used_at = ? WHERE token_hash = ?").bind(Date.now(), hash).run();
  return row;
}

async function ask(request, env) {
  requireConfig(env);
  await limit(env, request, "ask", 60, 60 * 1000);
  const hash = await digestToken(env, "access", bearer(request));
  const row = await env.DB.prepare(
    `SELECT t.expires_at, t.revoked_at, s.id AS subscription_id, s.status, s.paid_through, s.plan, s.units
     FROM tokens t JOIN subscriptions s ON s.id = t.subscription_id
     WHERE t.token_hash = ? AND t.kind = 'access'`,
  ).bind(hash).first();
  if (!row || row.revoked_at) throw new HttpError(401, "invalid_or_expired");
  const plan = planById(row.plan || "month");
  const now = Date.now();
  const periodOpen = row.expires_at > now && row.paid_through > now;
  const statusOk = row.status === "active" || row.status === "cancelled";
  if (!periodOpen || !statusOk) {
    throw new HttpError(401, "expired", { expires_at: showExpiry(plan, row.expires_at), plan: plan.id });
  }
  await env.DB.prepare("UPDATE tokens SET last_used_at = ? WHERE token_hash = ?").bind(now, hash).run();
  return json({
    access: true,
    command: "ask",
    plan: plan.id,
    expires_at: showExpiry(plan, row.expires_at),
    units: Number(row.units || 0),
  });
}

async function refresh(request, env) {
  const row = await loadRefresh(request, env);
  const plan = planById(row.plan || "month");
  if (row.paid_through <= Date.now() || (row.status !== "active" && row.status !== "cancelled")) {
    throw new HttpError(402, "payment_required", { paid_through: showExpiry(plan, row.paid_through), plan: plan.id });
  }
  await revokeKind(env, row.id, "access");
  const access = await minted(env, plan, "access");
  await env.DB.prepare(
    "INSERT INTO tokens (token_hash, subscription_id, kind, expires_at, created_at) VALUES (?, ?, 'access', ?, ?)",
  ).bind(access.hash, row.id, row.paid_through, Date.now()).run();
  return json({
    access_token: access.token,
    access_expires_at: showExpiry(plan, row.paid_through),
    token_type: "Bearer",
    command: "ask",
    plan: plan.id,
    cipher: plan.cipher,
    status: row.status,
    paid_through: showExpiry(plan, row.paid_through),
    units: Number(row.units || 0),
  });
}

async function subscriptionStatus(request, env) {
  const row = await loadRefresh(request, env);
  const plan = planById(row.plan || "month");
  const access = await env.DB.prepare(
    `SELECT expires_at FROM tokens
     WHERE subscription_id = ? AND kind = 'access' AND revoked_at IS NULL
     ORDER BY created_at DESC LIMIT 1`,
  ).bind(row.id).first();
  return json({
    subscription_id: row.id,
    status: row.status,
    plan: plan.id,
    command: "ask",
    amount: row.amount || plan.amount,
    currency: "USD",
    interval_days: plan.days,
    lifetime: !plan.days,
    cipher: plan.cipher,
    paid_through: showExpiry(plan, row.paid_through),
    access_expires_at: access?.expires_at ? showExpiry(plan, access.expires_at) : null,
    renewal_scheduled: Boolean(row.renewal_scheduled),
    card: { brand: row.card_brand || "", last4: row.card_last4 || "" },
    units: Number(row.units || 0),
    ...(String(row.authnet_transaction_id || "").startsWith("test:") ? { test_mode: true } : {}),
  });
}

async function cancel(request, env) {
  const row = await loadRefresh(request, env);
  const plan = planById(row.plan || "month");
  if (row.authnet_subscription_id) await cancelSubscription(env, row.authnet_subscription_id);
  const now = Date.now();
  await env.DB.prepare(
    `UPDATE subscriptions
     SET status = 'cancelled', renewal_scheduled = 0, cancelled_at = ?, updated_at = ?
     WHERE id = ?`,
  ).bind(now, now, row.id).run();
  return json({
    status: "cancelled",
    command: "ask",
    plan: plan.id,
    lifetime: !plan.days,
    paid_through: showExpiry(plan, row.paid_through),
  });
}

function isConstraint(err) {
  return /unique|constraint/i.test(String(err));
}

async function webhook(request, env) {
  requireConfig(env);
  const raw = await request.text();
  if (raw.length > 100000) throw new HttpError(413, "body_too_large");
  const header = request.headers.get("x-anet-signature") || "";
  if (!await webhookSignatureValid(env.AUTHNET_SIGNATURE_KEY, raw, header)) {
    throw new HttpError(401, "invalid_signature");
  }
  let event;
  try {
    event = JSON.parse(raw.replace(/^\uFEFF/, ""));
  } catch {
    return json({ ok: true, ignored: true });
  }
  const type = String(event.eventType || "");
  const payload = event.payload || {};
  const notificationId = String(event.notificationId || crypto.randomUUID());
  try {
    await env.DB.prepare(
      "INSERT INTO payments (id, subscription_id, authnet_trans_id, amount, kind, received_at) VALUES (?, NULL, ?, ?, 'webhook', ?)",
    ).bind(notificationId, String(payload.id || ""), payload.authAmount == null ? "" : String(payload.authAmount), Date.now()).run();
  } catch (err) {
    if (isConstraint(err)) return json({ ok: true, duplicate: true });
    throw err;
  }

  if (type === "net.authorize.payment.authcapture.created" && Number(payload.responseCode) === 1) {
    const transId = String(payload.id || "");
    const known = transId
      ? await env.DB.prepare("SELECT subscription_id FROM payments WHERE authnet_trans_id = ? AND kind = 'initial'").bind(transId).first()
      : null;
    if (!known && transId && transId !== "0") {
      const authnetSubscriptionId = await transactionSubscriptionId(env, transId);
      const sub = authnetSubscriptionId
        ? await env.DB.prepare(
          "SELECT id, paid_through, plan, status FROM subscriptions WHERE authnet_subscription_id = ?",
        ).bind(authnetSubscriptionId).first()
        : null;
      const amount = Number(payload.authAmount);
      const monthly = sub && (sub.plan || "month") === "month" && sub.status !== "superseded";
      if (monthly && Number.isFinite(amount) && Math.abs(amount - Number(PRICE)) < 0.001) {
        const next = Math.max(sub.paid_through, Date.now()) + PERIOD_MS;
        await env.DB.prepare(
          "UPDATE subscriptions SET status = 'active', paid_through = ?, updated_at = ? WHERE id = ?",
        ).bind(next, Date.now(), sub.id).run();
        await env.DB.prepare(
          "UPDATE payments SET subscription_id = ?, kind = 'renewal' WHERE id = ?",
        ).bind(sub.id, notificationId).run();
      }
    }
  }

  const terminal = {
    "net.authorize.customer.subscription.cancelled": "cancelled",
    "net.authorize.customer.subscription.terminated": "cancelled",
    "net.authorize.customer.subscription.suspended": "past_due",
  };
  if (terminal[type] && payload.id) {
    const now = Date.now();
    await env.DB.prepare(
      `UPDATE subscriptions
       SET status = ?, renewal_scheduled = 0, cancelled_at = CASE WHEN ? = 'cancelled' THEN ? ELSE cancelled_at END, updated_at = ?
       WHERE authnet_subscription_id = ? AND status != 'superseded'`,
    ).bind(terminal[type], terminal[type], now, now, String(payload.id)).run();
    if (terminal[type] === "past_due") {
      const sub = await env.DB.prepare(
        "SELECT id FROM subscriptions WHERE authnet_subscription_id = ? AND status != 'superseded'",
      ).bind(String(payload.id)).first();
      if (sub) await revokeKind(env, sub.id, "access");
    }
  }

  if ((type === "net.authorize.payment.refund.created" || type === "net.authorize.payment.void.created") && payload.id) {
    const payment = await env.DB.prepare(
      "SELECT subscription_id FROM payments WHERE authnet_trans_id = ? AND subscription_id IS NOT NULL LIMIT 1",
    ).bind(String(payload.id)).first();
    if (payment?.subscription_id) {
      const now = Date.now();
      await env.DB.prepare(
        "UPDATE subscriptions SET status = 'cancelled', paid_through = ?, cancelled_at = ?, renewal_scheduled = 0, updated_at = ? WHERE id = ? AND status != 'superseded'",
      ).bind(now, now, now, payment.subscription_id).run();
      await revokeKind(env, payment.subscription_id, "access");
    }
  }

  return json({ ok: true });
}

function catalog() {
  return {
    service: "nix-ask",
    command: "ask",
    amount: PRICE,
    currency: "USD",
    interval_days: 31,
    plans: publicPlans(),
    intents: "/intents",
    units: "/api/v1/units",
    packs: publicPacks(),
  };
}

async function grantIncluded(env, subscriptionId, plan) {
  const amount = plan.included || 0;
  if (!amount) {
    const row = await env.DB.prepare("SELECT units FROM subscriptions WHERE id = ?").bind(subscriptionId).first();
    return Number(row?.units || 0);
  }
  const now = Date.now();
  const ledgerId = `include:${subscriptionId}`;
  try {
    await env.DB.prepare(
      "INSERT INTO unit_ledger (id, subscription_id, delta, reason, balance_after, created_at) VALUES (?, ?, ?, 'included', 0, ?)",
    ).bind(ledgerId, subscriptionId, amount, now).run();
  } catch (err) {
    if (!isConstraint(err)) throw err;
    const row = await env.DB.prepare("SELECT units FROM subscriptions WHERE id = ?").bind(subscriptionId).first();
    return Number(row?.units || 0);
  }
  await env.DB.prepare("UPDATE subscriptions SET units = units + ?, updated_at = ? WHERE id = ?").bind(amount, now, subscriptionId).run();
  const row = await env.DB.prepare("SELECT units FROM subscriptions WHERE id = ?").bind(subscriptionId).first();
  const balance = Number(row?.units || 0);
  await env.DB.prepare("UPDATE unit_ledger SET balance_after = ? WHERE id = ?").bind(balance, ledgerId).run();
  return balance;
}

async function loadAccess(request, env) {
  requireConfig(env);
  const hash = await digestToken(env, "access", bearer(request));
  const row = await env.DB.prepare(
    `SELECT t.expires_at, t.revoked_at, s.id AS subscription_id, s.status, s.paid_through, s.plan, s.units
     FROM tokens t JOIN subscriptions s ON s.id = t.subscription_id
     WHERE t.token_hash = ? AND t.kind = 'access'`,
  ).bind(hash).first();
  if (!row || row.revoked_at) throw new HttpError(401, "invalid_or_expired");
  const plan = planById(row.plan || "month");
  const now = Date.now();
  const periodOpen = row.expires_at > now && row.paid_through > now;
  const statusOk = row.status === "active" || row.status === "cancelled";
  if (!periodOpen || !statusOk) {
    throw new HttpError(401, "expired", { expires_at: showExpiry(plan, row.expires_at), plan: plan.id });
  }
  await env.DB.prepare("UPDATE tokens SET last_used_at = ? WHERE token_hash = ?").bind(now, hash).run();
  return row;
}

function intentCatalog() {
  return json({
    service: "nix-intents",
    command: "ask",
    engine: "nix-template",
    authority: "dios",
    rate_limit: "20/min",
    intents: publicIntents(),
    packs: publicPacks(),
    units: "/api/v1/units",
  });
}

async function unitCatalog(request, env) {
  const body = { packs: publicPacks(), currency: "USD", purchase: "/api/v1/units" };
  if (request.headers.get("authorization")) {
    requireConfig(env);
    const row = await loadAccess(request, env);
    body.units = Number(row.units || 0);
    body.plan = planById(row.plan || "month").id;
  }
  return json(body);
}

async function runIntent(request, env) {
  requireConfig(env);
  await limit(env, request, "intents", 20, 60 * 1000);
  const row = await loadAccess(request, env);
  const body = await readBody(request);
  const idempotencyKey = requireIdempotencyKey(request.headers.get("idempotency-key"));
  const served = serveIntent(body.intent);
  if (served.error) throw new HttpError(400, served.error, { intents: "/intents" });
  const idempotencyHash = await tokenHash(env.TOKEN_PEPPER, `intent:${row.subscription_id}:${idempotencyKey}`);
  const prior = await env.DB.prepare(
    "SELECT cost, response_json FROM intent_calls WHERE idempotency_hash = ?",
  ).bind(idempotencyHash).first();
  if (prior) {
    const stored = JSON.parse(prior.response_json);
    stored.units = { cost: prior.cost, remaining: Number(row.units || 0), replayed: true };
    return json(stored);
  }
  let remaining = Number(row.units || 0);
  if (served.cost > 0) {
    const spent = await env.DB.prepare(
      "UPDATE subscriptions SET units = units - ?, updated_at = ? WHERE id = ? AND units >= ?",
    ).bind(served.cost, Date.now(), row.subscription_id, served.cost).run();
    if (!spent.meta?.changes) {
      throw new HttpError(402, "insufficient_units", {
        units: remaining,
        cost: served.cost,
        units_url: "/api/v1/units",
      });
    }
    const after = await env.DB.prepare("SELECT units FROM subscriptions WHERE id = ?").bind(row.subscription_id).first();
    remaining = Number(after?.units || 0);
  }
  const payload = { ...served.body, input: String(body.intent).trim().slice(0, 180) };
  const now = Date.now();
  try {
    await env.DB.prepare(
      "INSERT INTO intent_calls (idempotency_hash, subscription_id, intent, cost, response_json, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).bind(idempotencyHash, row.subscription_id, served.body.intent, served.cost, JSON.stringify(payload), now).run();
  } catch (err) {
    if (served.cost > 0) {
      await env.DB.prepare("UPDATE subscriptions SET units = units + ?, updated_at = ? WHERE id = ?").bind(served.cost, Date.now(), row.subscription_id).run();
    }
    if (isConstraint(err)) {
      const raced = await env.DB.prepare(
        "SELECT cost, response_json FROM intent_calls WHERE idempotency_hash = ?",
      ).bind(idempotencyHash).first();
      if (raced) {
        const stored = JSON.parse(raced.response_json);
        const latest = await env.DB.prepare("SELECT units FROM subscriptions WHERE id = ?").bind(row.subscription_id).first();
        stored.units = { cost: raced.cost, remaining: Number(latest?.units || 0), replayed: true };
        return json(stored);
      }
    }
    throw err;
  }
  if (served.cost > 0) {
    await env.DB.prepare(
      "INSERT INTO unit_ledger (id, subscription_id, delta, reason, balance_after, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).bind(idempotencyHash, row.subscription_id, -served.cost, served.body.intent, remaining, now).run();
  }
  payload.units = { cost: served.cost, remaining };
  return json(payload);
}

async function paidSubscription(env, deviceHash) {
  return env.DB.prepare(
    `SELECT id, units, plan, paid_through, status FROM subscriptions
     WHERE device_hash = ? AND status IN ('active', 'cancelled') AND paid_through > ?
     ORDER BY paid_through DESC LIMIT 1`,
  ).bind(deviceHash, Date.now()).first();
}

async function buyUnits(request, env) {
  requireConfig(env);
  const origin = request.headers.get("origin");
  if (origin && origin !== "null") throw new HttpError(403, "purchase_inside_nix_only");
  const body = await readBody(request);
  const deviceId = requireDeviceId(body.device_id);
  const idempotencyKey = requireIdempotencyKey(request.headers.get("idempotency-key"));
  const opaque = requireOpaqueData(body);
  const pack = requirePack(body.pack);
  const billTo = {
    firstName: requireName(body.bill_to?.first_name, "first_name_required"),
    lastName: requireName(body.bill_to?.last_name, "last_name_required"),
    zip: requirePostal(body.bill_to?.zip || body.bill_to?.postal_code),
    country: optionalCountry(body.bill_to?.country),
  };
  await limit(env, request, "units", 8, 60 * 60 * 1000);
  const deviceHash = await tokenHash(env.TOKEN_PEPPER, `device:${deviceId}`);
  const idempotencyHash = await tokenHash(env.TOKEN_PEPPER, `unit:${deviceHash}:${idempotencyKey}`);
  const sub = await paidSubscription(env, deviceHash);
  if (!sub) throw new HttpError(409, "subscription_required");
  const prior = await env.DB.prepare("SELECT * FROM unit_purchases WHERE idempotency_hash = ?").bind(idempotencyHash).first();
  if (prior) {
    if (prior.subscription_id !== sub.id) throw new HttpError(409, "idempotency_device_mismatch");
    if (prior.status === "charging") throw new HttpError(409, "payment_in_progress", { reference: prior.id });
    if (prior.status !== "paid") throw new HttpError(409, "use_new_idempotency_key", { reference: prior.id });
    return json({
      pack: prior.pack,
      units_added: prior.units,
      units: Number(sub.units || 0),
      amount: prior.amount,
      currency: "USD",
      subscription_id: sub.id,
      replayed: true,
    });
  }
  const id = crypto.randomUUID();
  const now = Date.now();
  const refId = id.replaceAll("-", "").slice(0, 20);
  await env.DB.prepare(
    `INSERT INTO unit_purchases (
      id, idempotency_hash, subscription_id, pack, units, amount, status, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, 'charging', ?)`,
  ).bind(id, idempotencyHash, sub.id, pack.id, pack.units, pack.amount, now).run();
  let charge;
  try {
    charge = await chargeOpaque(env, {
      refId,
      opaque,
      billTo,
      customerId: refId,
      amount: pack.amount,
      description: `NIX intents ${pack.id}`,
    });
  } catch (err) {
    const code = err instanceof HttpError ? err.code : "payment_declined";
    await env.DB.prepare("UPDATE unit_purchases SET status = ? WHERE id = ?").bind(code === "payment_unconfirmed" ? "review" : "failed", id).run();
    if (err instanceof HttpError) err.extra = { ...err.extra, reference: id };
    throw err;
  }
  await env.DB.prepare(
    "UPDATE subscriptions SET units = units + ?, updated_at = ? WHERE id = ?",
  ).bind(pack.units, Date.now(), sub.id).run();
  const after = await env.DB.prepare("SELECT units FROM subscriptions WHERE id = ?").bind(sub.id).first();
  const balance = Number(after?.units || 0);
  await env.DB.prepare(
    "UPDATE unit_purchases SET status = 'paid', authnet_trans_id = ? WHERE id = ?",
  ).bind(charge.transId, id).run();
  try {
    await env.DB.prepare(
      "INSERT INTO payments (id, subscription_id, authnet_trans_id, amount, kind, received_at) VALUES (?, ?, ?, ?, 'units', ?)",
    ).bind(charge.transId, sub.id, charge.transId, charge.amount, Date.now()).run();
    await env.DB.prepare(
      "INSERT INTO unit_ledger (id, subscription_id, delta, reason, balance_after, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).bind(id, sub.id, pack.units, pack.id, balance, Date.now()).run();
  } catch (err) {
    if (!isConstraint(err)) throw err;
  }
  return json({
    pack: pack.id,
    units_added: pack.units,
    units: balance,
    amount: pack.amount,
    currency: "USD",
    subscription_id: sub.id,
    ...(charge.testMode ? { test_mode: true } : {}),
  }, 201);
}

async function health(env) {
  if (!env.DB) throw new HttpError(500, "misconfigured");
  await env.DB.prepare("SELECT 1 AS ok").first();
  return json({ ok: true, ...catalog() });
}

async function route(request, env, url) {
  const path = url.pathname.replace(/\/+$/, "") || "/";
  if (request.method === "GET" && path === "/api/v1/health") return health(env);
  if (request.method === "GET" && path === "/api") return json({ ...catalog(), health: "/api/v1/health" });
  if (request.method === "GET" && (path === "/intents" || path === "/intent")) return intentCatalog();
  if (request.method === "GET" && path === "/api/v1/units") return unitCatalog(request, env);
  if (request.method !== "POST") throw new HttpError(405, "method_not_allowed");
  if (path === "/intents" || path === "/intent") return runIntent(request, env);
  if (path === "/api/v1/units") return buyUnits(request, env);
  if (path === "/api/v1/subscribe") return subscribe(request, env);
  if (path === "/api/v1/ask") return ask(request, env);
  if (path === "/api/v1/token/refresh") return refresh(request, env);
  if (path === "/api/v1/subscription") return subscriptionStatus(request, env);
  if (path === "/api/v1/subscription/cancel") return cancel(request, env);
  if (path === "/api/v1/authorize/webhook") return webhook(request, env);
  throw new HttpError(404, "not_found");
}

async function markPastDue(env) {
  const now = Date.now();
  await env.DB.prepare(
    "UPDATE subscriptions SET status = 'past_due', updated_at = ? WHERE status = 'active' AND plan != 'lifetime' AND paid_through < ?",
  ).bind(now, now).run();
  await env.DB.prepare(
    `UPDATE tokens SET revoked_at = ?
     WHERE kind = 'access' AND revoked_at IS NULL AND expires_at < ?`,
  ).bind(now, now).run();
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    if (path === "/api" || path.startsWith("/api/") || path === "/intent" || path.startsWith("/intent/") || path === "/intents" || path.startsWith("/intents/")) {
      try {
        return await route(request, env, url);
      } catch (err) {
        if (err instanceof HttpError) return json({ error: err.code, ...err.extra }, err.status);
        console.error("api_error");
        return json({ error: "internal" }, 500);
      }
    }
    return env.ASSETS.fetch(request);
  },
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(markPastDue(env));
  },
};
