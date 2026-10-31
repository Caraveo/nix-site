import assert from "node:assert/strict";
import test from "node:test";
import { PACKS, requirePack } from "./units.js";
import { serveIntent } from "./intents.js";
import { PLANS } from "./plans.js";
import { HttpError } from "./validate.js";

test("reach returns ping and whois for a safe host", () => {
  const served = serveIntent("is google.com up?");
  assert.equal(served.cost, 1);
  assert.equal(served.body.intent, "reach");
  assert.equal(served.body.host, "google.com");
  assert.deepEqual(served.body.scripts[0].argv, ["ping", "-c", "3", "google.com"]);
  assert.equal(served.body.scripts[0].shell, "ping -c 3 google.com");
  assert.deepEqual(served.body.scripts[1].argv, ["whois", "google.com"]);
  assert.equal(served.body.scripts[1].shell, "whois google.com");
  assert.equal(serveIntent("is https://google.com up?").body.host, "google.com");
  assert.equal(serveIntent("ping 1.1.1.1").body.scripts[0].shell, "ping -c 3 1.1.1.1");
});

test("reach refuses shell metacharacters", () => {
  assert.equal(serveIntent("is google.com;id up").error, "intent_invalid");
  assert.equal(serveIntent("ping google.com && id").error, "intent_unknown");
  assert.equal(serveIntent("whois $(id)").error, "intent_invalid");
  assert.equal(serveIntent("is 999.999.999.999 up").error, "intent_invalid");
  assert.equal(serveIntent("check google.com;rm -rf").error, "intent_unknown");
});

test("ask ubuntu returns the NIX guest boot template", () => {
  const served = serveIntent("ask ubuntu");
  assert.equal(served.cost, 1);
  assert.equal(served.body.intent, "installos");
  assert.equal(served.body.guest, "ubuntu");
  assert.equal(served.body.marker, "NIX_BOOT_GUEST ubuntu");
  assert.equal(served.body.inside_nix, "linux_guest_enter");
  assert.equal(served.body.scripts[0].shell, "./scripts/guest-stack.sh boot ubuntu");
  assert.deepEqual(served.body.scripts[0].argv, ["./scripts/guest-stack.sh", "boot", "ubuntu"]);
  assert.equal(served.body.confirm[0], "NIX is not Linux. NIX stays the host.");
  assert.equal(served.body.authority, "dios");
  assert.equal(served.body.again, false);
  assert.equal(serveIntent("ask ubuntu again").body.again, true);
  assert.equal(serveIntent("ask debian").body.marker, "NIX_BOOT_GUEST debian");
  assert.equal(serveIntent("ask centos").body.scripts[0].shell, "./scripts/guest-stack.sh boot centos");
});

test("ask kernel returns the linux 7.3.1 build template", () => {
  const served = serveIntent("ask kernel");
  assert.equal(served.cost, 1);
  assert.equal(served.body.marker, "NIX_BUILD_KERNEL linux-7.3.1");
  assert.equal(served.body.scripts[0].shell, "./scripts/guest-stack.sh fetch");
  assert.equal(served.body.scripts[1].shell, "./scripts/guest-stack.sh build");
  assert.equal(served.body.source, "https://cdn.kernel.org/pub/linux/kernel/v7.x/linux-7.3.1.tar.xz");
});

test("pod intents record a name and do not start a container", () => {
  const served = serveIntent("intent install editor");
  assert.equal(served.cost, 1);
  assert.equal(served.body.intent, "pod");
  assert.equal(served.body.verb, "install");
  assert.equal(served.body.name, "editor");
  assert.equal(served.body.starts_container, false);
  assert.equal(served.body.scripts.length, 0);
  assert.match(served.body.confirm[0], /Install editor as a pod/);
  assert.equal(serveIntent("intent install ../x").error, "intent_invalid");
  assert.equal(serveIntent("intent launch editor").body.verb, "launch");
});

test("unbuilt guests return no script and still cost one unit", () => {
  const windows = serveIntent("ask windows 11");
  assert.equal(windows.cost, 1);
  assert.equal(windows.body.available, false);
  assert.equal(windows.body.version, "11");
  assert.equal(windows.body.scripts.length, 0);
  const bsd = serveIntent("ask bsd");
  assert.equal(bsd.cost, 1);
  assert.equal(bsd.body.available, false);
  assert.match(bsd.body.say, /FreeBSD kernel is not built/);
  assert.equal(serveIntent("install ubuntu extra").error, "intent_invalid");
  assert.equal(serveIntent("make me a sandwich").error, "intent_unknown");
});

test("unit packs are priced on the server and one call costs one unit", () => {
  assert.equal(requirePack("100").units, 100);
  assert.equal(requirePack("medium").amount, "12.99");
  assert.equal(PACKS.pack2000.amount, "39.99");
  assert.equal(PACKS.pack2000.units, 2000);
  assert.throws(() => requirePack("pack1"), (err) => err instanceof HttpError && err.code === "unknown_pack");
  assert.equal(PLANS.month.included, 25);
  assert.equal(PLANS.year.included, 300);
  assert.equal(PLANS.year5.included, 1500);
  assert.equal(PLANS.year10.included, 3000);
  assert.equal(PLANS.lifetime.included, 5000);
});
