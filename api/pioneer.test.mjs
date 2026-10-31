import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { reserve, complete, refund } from "./pioneer-ledger.js";
import { pioneerRoute, parseCompletion, completionResponse } from "./pioneer.js";

function fixture(credits = 2) {
  const sql = new DatabaseSync(":memory:");
  sql.exec(readFileSync(new URL("./schema.sql", import.meta.url), "utf8"));
  sql.exec(readFileSync(new URL("./pioneer-schema.sql", import.meta.url), "utf8"));
  sql.prepare(`INSERT INTO subscriptions
    (id, device_hash, idempotency_hash, status, paid_through, created_at, updated_at, units)
    VALUES ('paid', 'device', 'purchase', 'active', ?, 0, 0, ?)`)
    .run(Date.now() + 86400000, credits);
  const db = {
    prepare(text) {
      const statement = sql.prepare(text);
      let values = [];
      return {
        bind(...args) { values = args; return this; },
        async first() { return statement.get(...values) ?? null; },
        async all() { return { results: statement.all(...values) }; },
        async run() { return { meta: { changes: statement.run(...values).changes } }; },
      };
    },
    async batch(statements) {
      sql.exec("BEGIN");
      try {
        const results = [];
        for (const statement of statements) results.push(await statement.run());
        sql.exec("COMMIT"); return results;
      } catch (error) { sql.exec("ROLLBACK"); throw error; }
    },
  };
  const balance = () => sql.prepare("SELECT units FROM subscriptions WHERE id = 'paid'").get().units;
  return { db, sql, balance };
}
const key = "request-0000000001";
const payload = { model: "pioneer", messages: [{ role: "user", content: "Build a small program" }] };
const request = (body = payload) => new Request("https://core-nix.com/intent/v1/chat/completions", {
  method: "POST", headers: { "idempotency-key": key }, body: JSON.stringify(body),
});

test("one credit per unique request; completed retries do not charge again", async () => {
  const { db, sql, balance } = fixture();
  const reservation = await reserve(db, "paid", key, "hash");
  assert.equal(balance(), 1);
  await assert.rejects(reserve(db, "paid", key, "hash"), { code: "request_in_progress" });
  await assert.rejects(reserve(db, "paid", key, "other"), { code: "idempotency_conflict" });
  await complete(db, reservation, { result: "saved" });
  assert.deepEqual((await reserve(db, "paid", key, "hash")).cached, { result: "saved" });
  assert.equal(balance(), 1);
  assert.equal(sql.prepare("SELECT count(*) AS n FROM unit_ledger").get().n, 1);
  sql.close();
});

test("failures refund exactly once and cannot refund a completed call", async () => {
  const { db, sql, balance } = fixture(1);
  const reservation = await reserve(db, "paid", key, "hash");
  assert.equal(balance(), 0);
  assert.equal(await refund(db, reservation), true);
  assert.equal(await refund(db, reservation), false);
  assert.equal(balance(), 1);
  await assert.rejects(reserve(db, "paid", key, "hash"), { code: "request_failed_use_new_id" });
  const next = await reserve(db, "paid", key + "2", "hash");
  await complete(db, next, { ok: true });
  assert.equal(await refund(db, next), false);
  assert.equal(balance(), 0);
  sql.close();
});

test("empty or expired accounts cannot reserve credits", async () => {
  const { db, sql, balance } = fixture(0);
  await assert.rejects(reserve(db, "paid", key, "hash"), { status: 402 });
  sql.exec("UPDATE subscriptions SET units = 2, paid_through = 1");
  await assert.rejects(reserve(db, "paid", key, "hash"), { status: 402 });
  assert.equal(balance(), 2);
  sql.close();
});

test("billing transaction rolls back entirely on ledger failure", async () => {
  const { db, sql, balance } = fixture();
  sql.exec("CREATE TRIGGER reject_debit BEFORE INSERT ON unit_ledger BEGIN SELECT RAISE(ABORT, 'disk failure'); END");
  await assert.rejects(reserve(db, "paid", key, "hash"));
  assert.equal(balance(), 2);
  assert.equal(sql.prepare("SELECT count(*) AS n FROM pioneer_calls").get().n, 0);
  sql.close();
});

test("only the paid Pioneer model and bounded text/tool requests are accepted", async () => {
  await assert.rejects(parseCompletion(request({ ...payload, model: "other" })), { status: 400 });
  await assert.rejects(parseCompletion(request({ ...payload, max_tokens: 999999 })), { status: 400 });
  await assert.rejects(parseCompletion(request({ ...payload, messages: [{ role: "user", content: "a".repeat(131072) }] })), { status: 413 });
  const parsed = await parseCompletion(request(payload));
  assert.equal(parsed.input.max_tokens, 4096);
  await assert.rejects(pioneerRoute(request(), {}, "/intent/v1/chat/completions",
    async () => ({ authnet_transaction_id: "test:fake" })), { code: "paid_token_required" });
});

test("private Agent inference, replay, tool-call SSE, and provider failure use real SQL credits", async () => {
  const { db, sql, balance } = fixture();
  const result = { id: "chatcmpl-example", created: 1, model: "pioneer", choices: [{ index: 0,
    message: { role: "assistant", content: null, tool_calls: [{ id: "tool-1", type: "function",
      function: { name: "bash", arguments: '{"command":"make"}' } }] }, finish_reason: "tool_calls" }], usage: {} };
  let runs = 0;
  const env = { DB: db, AI: {}, PIONEER: { idFromName: name => name,
    get: name => ({ async fetch(req) { assert.equal(name, "paid");
      assert.equal(req.headers.get("authorization"), null);
      runs++; return Response.json(result); } }) } };
  const getAgent = async name => env.PIONEER.get(name);
  const access = async () => ({ subscription_id: "paid", authnet_transaction_id: "12345" });
  const response = await pioneerRoute(request(), env, "/intent/v1/chat/completions", access, getAgent);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), result);
  await pioneerRoute(request(), env, "/intent/v1/chat/completions", access, getAgent);
  assert.equal(runs, 1); assert.equal(balance(), 1);
  const sse = await completionResponse(result, true).text();
  assert.match(sse, /"finish_reason":"tool_calls"/);
  assert.match(sse, /"index":0,"id":"tool-1"/);
  assert.match(sse, /data: \[DONE\]/);
  env.PIONEER.get = () => ({ fetch: async () => { throw new Error("upstream unavailable"); } });
  const failed = new Request(request(), { headers: { "idempotency-key": key + "-failure" } });
  await assert.rejects(pioneerRoute(failed, env, "/intent/v1/chat/completions", access, getAgent),
    error => error.code === "pioneer_failed" && error.extra.refunded === true);
  assert.equal(balance(), 1);
  sql.close();
});
