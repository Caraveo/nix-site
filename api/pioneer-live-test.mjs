// Explicit integration test: local D1/token fixtures, real Cloudflare inference.
// No production account, subscription, payment, or credit record is changed.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { mintToken, tokenHash } from "./token.js";

if (process.env.PIONEER_LIVE_AI !== "1") throw new Error("Set PIONEER_LIVE_AI=1 to run real inference");
const root = resolve(new URL("..", import.meta.url).pathname);
const work = mkdtempSync(join(tmpdir(), "pioneer-api-"));
const pepper = "17".repeat(32); // Local fixture, never a production secret.
const token = mintToken();
const now = Date.now();
const hash = await tokenHash(pepper, `access:${token}`);
const config = JSON.parse(readFileSync(join(root, "wrangler.jsonc"), "utf8"));
delete config.routes; delete config.triggers; delete config.build; delete config.assets;
config.name = "nix-pioneer-local-test";
config.main = join(root, "api/worker.js");
config.vars = { TOKEN_PEPPER: pepper, AUTHNET_API_LOGIN_ID: "local-fixture",
  AUTHNET_TRANSACTION_KEY: "local-fixture", AUTHNET_SIGNATURE_KEY: "23".repeat(64) };
const configFile = join(work, "wrangler.jsonc");
writeFileSync(configFile, JSON.stringify(config));
const schema = ["schema.sql", "pioneer-schema.sql"].map(name =>
  readFileSync(join(root, "api", name), "utf8")).join("\n");
const fixture = join(work, "fixture.sql");
writeFileSync(fixture, schema + `
INSERT INTO subscriptions (id, device_hash, idempotency_hash, status, plan,
paid_through, authnet_transaction_id, units, created_at, updated_at)
VALUES ('local-paid', 'fixture', 'fixture', 'active', 'month', ${now + 86400000}, 'local-paid-fixture', 2, ${now}, ${now});
INSERT INTO tokens (token_hash, subscription_id, kind, expires_at, created_at)
VALUES ('${hash}', 'local-paid', 'access', ${now + 86400000}, ${now});`);
const wrangler = join(root, "node_modules/.bin/wrangler");
execFileSync(wrangler, ["d1", "execute", "nix-ask", "--config", configFile,
  "--local", "--persist-to", join(work, "state"), "--file", fixture], { cwd: root, stdio: "pipe" });
const log = [];
const worker = spawn(wrangler, ["dev", "--config", configFile,
  "--ip", "127.0.0.1", "--port", "18787", "--persist-to", join(work, "state")],
  { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
worker.stdout.on("data", data => log.push(data.toString()));
worker.stderr.on("data", data => log.push(data.toString()));
const endpoint = "http://127.0.0.1:18787/intent/v1";
const headers = { authorization: `Bearer ${token}`, "content-type": "application/json",
  "idempotency-key": "live-local-fixture-0001" };
try {
  let ready = false;
  for (let attempt = 0; attempt < 90; attempt++) {
    if (worker.exitCode !== null) throw new Error(log.join(""));
    try { const response = await fetch(endpoint + "/account", { headers });
      if (response.ok) { ready = true; break; } } catch {}
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  assert(ready, log.join(""));
  const denied = await fetch(endpoint + "/models");
  assert.equal(denied.status, 401);
  const body = JSON.stringify({ model: "pioneer", max_tokens: 256,
    messages: [{ role: "user", content: "Reply with the exact text PIONEER_API_OK and nothing else." }] });
  const response = await fetch(endpoint + "/chat/completions", { method: "POST", headers, body });
  const result = await response.json();
  if (!response.ok) await new Promise(resolve => setTimeout(resolve, 1000));
  assert.equal(response.status, 200, JSON.stringify(result) + "\n" + log.join(""));
  assert.equal(result.model, "pioneer");
  assert(result.choices[0].message.content.length);
  const replay = await fetch(endpoint + "/chat/completions", { method: "POST", headers, body });
  assert.deepEqual(await replay.json(), result);
  const account = await (await fetch(endpoint + "/account", { headers })).json();
  assert.equal(account.credits, 1);
  console.log("PASS: real Cloudflare Agent inference, paid-token gate, one local credit, replay without duplicate charge");
} finally {
  if (worker.exitCode === null) {
    const exited = new Promise(resolve => worker.once("exit", resolve));
    worker.kill("SIGTERM");
    await exited;
  }
  rmSync(work, { recursive: true, force: true });
}
