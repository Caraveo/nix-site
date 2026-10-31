import assert from "node:assert/strict";
import test from "node:test";
import { approvedTransaction, chargeOpaque } from "./authnet.js";
import { cipherMac, openToken, sealToken, tokenMac } from "./cipher.js";
import { LIFETIME_THROUGH, PLANS, paidUntil, planFromToken, publicPlans, requirePlan, showExpiry } from "./plans.js";
import {
  PERIOD_MS,
  TOKEN_BYTES,
  arbStartDate,
  hexToBytes,
  hmacHex,
  mintToken,
  tokenHash,
  transactionHashValid,
  webhookSignatureValid,
} from "./token.js";
import { rejectCardFields, requireOpaqueData, HttpError } from "./validate.js";

test("access tokens are 256 unguessable characters", () => {
  const first = mintToken();
  const second = mintToken();
  assert.equal(first.length, 256);
  assert.equal(TOKEN_BYTES * 4 / 3, 256);
  assert.match(first, /^[A-Za-z0-9_-]{256}$/);
  assert.notEqual(first, second);
});

test("token hashes are peppered and not reversible", async () => {
  const pepper = "ab".repeat(32);
  const token = mintToken();
  const hash = await tokenHash(pepper, token);
  assert.equal(hash.length, 64);
  assert.equal(hash, await tokenHash(pepper, token));
  assert.notEqual(hash, await tokenHash("cd".repeat(32), token));
  assert.equal(hash.includes(token.slice(0, 8)), false);
});

test("webhook signatures use the decoded signature key", async () => {
  const key = "aa".repeat(64);
  const body = '{"eventType":"net.authorize.payment.authcapture.created"}';
  const signature = await hmacHex("SHA-512", hexToBytes(key), body);
  assert.equal(await webhookSignatureValid(key, body, `sha512=${signature.toUpperCase()}`), true);
  const flipped = `${signature[0] === "0" ? "1" : "0"}${signature.slice(1)}`;
  assert.equal(await webhookSignatureValid(key, body, `sha512=${flipped}`), false);
  assert.equal(await webhookSignatureValid(key, `${body} `, `sha512=${signature}`), false);
});

test("transaction responses must match the gateway hash", async () => {
  const key = "11".repeat(64);
  const signature = await hmacHex("SHA-512", hexToBytes(key), "^login^42^2.99^");
  assert.equal(await transactionHashValid(key, "login", "42", "2.99", signature), true);
  assert.equal(await transactionHashValid(key, "login", "42", "2.98", signature), false);
});

test("raw card fields and digit pans are refused", () => {
  assert.throws(() => rejectCardFields({ card_number: "4111111111111111" }), HttpError);
  assert.throws(() => requireOpaqueData({ opaque_data: { data_descriptor: "COMMON.ACCEPT.INAPP.PAYMENT", data_value: "4111111111111111" } }), HttpError);
  const opaque = requireOpaqueData({
    opaque_data: { data_descriptor: "COMMON.ACCEPT.INAPP.PAYMENT", data_value: "A".repeat(40) },
  });
  assert.equal(opaque.dataDescriptor, "COMMON.ACCEPT.INAPP.PAYMENT");
});

test("test-mode approvals count and live declines do not", async () => {
  assert.equal(approvedTransaction({ responseCode: "2", transId: "81882396070", testRequest: "0" }), null);
  assert.equal(approvedTransaction({ responseCode: "1", transId: "0", testRequest: "0" }), null);
  assert.deepEqual(approvedTransaction({ responseCode: "1", transId: "0", testRequest: "1" }), { testMode: true, transId: "0" });
  assert.deepEqual(approvedTransaction({ responseCode: "1", transId: "42", testRequest: "0" }), { testMode: false, transId: "42" });

  const login = "login";
  const key = "11".repeat(64);
  const env = {
    AUTHNET_API_LOGIN_ID: login,
    AUTHNET_TRANSACTION_KEY: "transactionkey16",
    AUTHNET_SIGNATURE_KEY: key,
    AUTHNET_API_URL: "https://gateway.test/charge",
  };
  const hash = await hmacHex("SHA-512", hexToBytes(key), "^login^0^2.99^");
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    transactionResponse: {
      responseCode: "1",
      transId: "0",
      testRequest: "1",
      accountType: "Visa",
      accountNumber: "XXXX1111",
      transHashSha2: hash,
    },
    messages: { resultCode: "Ok", message: [{ code: "I00001", text: "Successful." }] },
  }));
  try {
    const charge = await chargeOpaque(env, {
      refId: "abc123abc123abc123ab",
      opaque: { dataDescriptor: "COMMON.ACCEPT.INAPP.PAYMENT", dataValue: "A".repeat(40) },
      billTo: { firstName: "Ada", lastName: "Lovelace", zip: "94107", country: "US" },
      customerId: "abc123abc123abc123ab",
      amount: "2.99",
    });
    assert.equal(charge.testMode, true);
    assert.equal(charge.transId, "test:abc123abc123abc123ab");
    assert.equal(charge.gatewayTransId, "0");
    assert.equal(charge.last4, "1111");
    assert.equal(charge.amount, "2.99");
  } finally {
    globalThis.fetch = realFetch;
  }

  globalThis.fetch = async () => new Response(JSON.stringify({
    transactionResponse: { responseCode: "1", transId: "0", testRequest: "1", transHashSha2: "00" },
    messages: { resultCode: "Ok", message: [{ code: "I00001", text: "Successful." }] },
  }));
  try {
    await assert.rejects(
      () => chargeOpaque(env, {
        refId: "abc123abc123abc123ab",
        opaque: { dataDescriptor: "COMMON.ACCEPT.INAPP.PAYMENT", dataValue: "A".repeat(40) },
        billTo: { firstName: "Ada", lastName: "Lovelace", zip: "94107", country: "US" },
        customerId: "abc123abc123abc123ab",
        amount: "2.99",
      }),
      (err) => err instanceof HttpError && err.code === "payment_unconfirmed",
    );
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("the billing date lands 31 days ahead", () => {
  const now = Date.parse("2026-01-01T00:00:00.000Z");
  assert.equal(arbStartDate(now), "2026-02-01");
  assert.equal(PERIOD_MS, 31 * 24 * 60 * 60 * 1000);
});

function cents(amount) {
  return Math.round(Number(amount) * 100);
}

test("prepaid plans are exact multiples and lifetime is 500", () => {
  assert.equal(PLANS.month.amount, "2.99");
  assert.equal(PLANS.year.amount, "35.88");
  assert.equal(PLANS.year5.amount, "179.40");
  assert.equal(PLANS.year10.amount, "358.80");
  assert.equal(PLANS.lifetime.amount, "500.00");
  assert.equal(cents(PLANS.year.amount), cents(PLANS.month.amount) * 12);
  assert.equal(cents(PLANS.year5.amount), cents(PLANS.month.amount) * 60);
  assert.equal(cents(PLANS.year10.amount), cents(PLANS.month.amount) * 120);
  assert.equal(PLANS.month.recurring, true);
  assert.equal(PLANS.year.recurring, false);
  assert.equal(PLANS.lifetime.recurring, false);
  assert.equal(PLANS.month.cipher, "hmac-sha256");
  assert.equal(PLANS.year.cipher, "aes-256-gcm+hmac-sha384");
  assert.match(PLANS.year5.cipher, /hmac-sha512/);
  assert.match(PLANS.lifetime.cipher, /aes-256-gcm/);
  assert.ok(PLANS.month.rank < PLANS.year.rank);
  assert.ok(PLANS.year.rank < PLANS.year5.rank);
  assert.ok(PLANS.year5.rank < PLANS.year10.rank);
  assert.ok(PLANS.year10.rank < PLANS.lifetime.rank);
  assert.equal(requirePlan(null).id, "month");
  assert.equal(requirePlan("").id, "month");
  assert.equal(requirePlan("ANNUAL").id, "year");
  assert.equal(requirePlan("5y").id, "year5");
  assert.equal(requirePlan("10year").id, "year10");
  assert.equal(requirePlan("forever").id, "lifetime");
  assert.throws(() => requirePlan("weekly"), (err) => err instanceof HttpError && err.code === "unknown_plan");
  const listed = publicPlans();
  assert.equal(listed.length, 5);
  assert.equal(listed.find((plan) => plan.id === "lifetime").lifetime, true);
  assert.equal(listed.find((plan) => plan.id === "lifetime").interval_days, null);
  assert.equal(listed.find((plan) => plan.id === "year").amount, "35.88");
});

test("long plans seal with a stronger cipher and stay plan-specific", async () => {
  const pepper = "ab".repeat(32);
  const other = "cd".repeat(32);
  const now = Date.parse("2026-01-01T00:00:00.000Z");
  assert.equal(planFromToken("a".repeat(256)).id, "month");
  assert.equal(await openToken(pepper, mintToken()), null);
  assert.equal(paidUntil(PLANS.year, now), now + 365 * 24 * 60 * 60 * 1000);
  assert.equal(paidUntil(PLANS.year5, now), now + 1825 * 24 * 60 * 60 * 1000);
  assert.equal(paidUntil(PLANS.year10, now), now + 3650 * 24 * 60 * 60 * 1000);
  assert.equal(paidUntil(PLANS.lifetime, now), LIFETIME_THROUGH);
  assert.equal(showExpiry(PLANS.lifetime, LIFETIME_THROUGH), null);
  assert.equal(showExpiry(PLANS.year, now), new Date(now).toISOString());

  for (const plan of [PLANS.year, PLANS.year5, PLANS.year10, PLANS.lifetime]) {
    const access = await sealToken(pepper, plan, "access");
    const refresh = await sealToken(pepper, plan, "refresh");
    assert.equal(access.length, plan.prefix.length + plan.bodyChars);
    assert.notEqual(access, refresh);
    assert.equal((await openToken(pepper, access)).kind, "access");
    assert.equal((await openToken(pepper, access)).plan.id, plan.id);
    assert.equal((await openToken(pepper, refresh)).kind, "refresh");
    assert.equal(await openToken(other, access), null);
    assert.equal(await tokenMac(pepper, plan, "refresh", access), null);
    const mac = await tokenMac(pepper, plan, "access", access);
    assert.equal(mac.length, plan.macBytes * 2);
    assert.equal(mac, await cipherMac(pepper, plan, `access:${access}`));
    assert.equal(mac.includes(access.slice(plan.prefix.length, plan.prefix.length + 8)), false);
    const flipped = `${access.slice(0, -1)}${access.at(-1) === "A" ? "B" : "A"}`;
    assert.equal(await openToken(pepper, flipped), null);
  }

  const year = await sealToken(pepper, PLANS.year, "access");
  assert.equal(await openToken(pepper, `y5.${year.slice(3)}`), null);
  assert.notEqual(await cipherMac(pepper, PLANS.year10, "same"), await cipherMac(pepper, PLANS.lifetime, "same"));
  assert.equal(planFromToken(`y1.${"a".repeat(256)}`).id, "year");
  assert.equal(planFromToken(`y5.${"a".repeat(256)}`).id, "year5");
  assert.equal(planFromToken(`ya.${"a".repeat(384)}`).id, "year10");
  assert.equal(planFromToken(`lt.${"a".repeat(512)}`).id, "lifetime");
  assert.equal(planFromToken(`y1.${"a".repeat(255)}`), null);
  assert.equal(planFromToken(`lt.${"a".repeat(256)}`), null);
});
