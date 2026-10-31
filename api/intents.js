const HOST = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const GUESTS = {
  debian: "Debian GNU userspace.",
  ubuntu: "Ubuntu GNU userspace.",
  centos: "CentOS GNU userspace.",
};
const REPLACE = ["reinstall", "overwrite", "again", "replace"];

function clean(text) {
  return String(text || "").trim().toLowerCase().replace(/[?!.]+$/g, "").trim();
}

function ipv4(host) {
  const parts = host.split(".");
  if (parts.length !== 4) return false;
  return parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255 && String(Number(part)) === part);
}

function hostOk(host) {
  if (!host || host.length > 253) return false;
  if (/^\d+(?:\.\d+){3}$/.test(host)) return ipv4(host);
  if (ipv4(host)) return true;
  if (!HOST.test(host)) return false;
  return host.split(".").every((label) => label.length <= 63 && !label.startsWith("-") && !label.endsWith("-"));
}

function reach(host) {
  return {
    intent: "reach",
    available: true,
    engine: "nix-template",
    cost: 1,
    host,
    authority: "dios",
    model_cannot_confirm: true,
    network: "required",
    runs_on: "host",
    confirm: [`Check ${host}? [y/n]`],
    scripts: [
      { id: "ping", shell: `ping -c 3 ${host}`, argv: ["ping", "-c", "3", host] },
      { id: "whois", shell: `whois ${host}`, argv: ["whois", host] },
    ],
  };
}

function installos(name, again) {
  return {
    intent: "installos",
    available: true,
    engine: "nix-template",
    cost: 1,
    guest: name,
    again: Boolean(again),
    authority: "dios",
    model_cannot_confirm: true,
    host: "nix",
    kernel: "linux-7.3.1",
    network: "host",
    runs_on: "host",
    confirm: [
      "NIX is not Linux. NIX stays the host.",
      `Stack: Linux 7.3.1 and ${GUESTS[name]}`,
      "Confirm as dios? [y/n]",
    ],
    marker: `NIX_BOOT_GUEST ${name}`,
    inside_nix: "linux_guest_enter",
    scripts: [
      {
        id: "boot-userspace",
        shell: `./scripts/guest-stack.sh boot ${name}`,
        argv: ["./scripts/guest-stack.sh", "boot", name],
      },
    ],
    replace_words: REPLACE,
  };
}

function kernel(again) {
  return {
    intent: "kernel",
    available: true,
    engine: "nix-template",
    cost: 1,
    again: Boolean(again),
    authority: "dios",
    model_cannot_confirm: true,
    kernel: "linux-7.3.1",
    source: "https://cdn.kernel.org/pub/linux/kernel/v7.x/linux-7.3.1.tar.xz",
    network: "host",
    runs_on: "host",
    confirm: [
      "NIX is not Linux. NIX stays the host.",
      "Guest kernel is Linux 7.3.1 from kernel.org.",
      "Confirm as dios? [y/n]",
    ],
    marker: "NIX_BUILD_KERNEL linux-7.3.1",
    scripts: [
      { id: "fetch", shell: "./scripts/guest-stack.sh fetch", argv: ["./scripts/guest-stack.sh", "fetch"] },
      { id: "build", shell: "./scripts/guest-stack.sh build", argv: ["./scripts/guest-stack.sh", "build"] },
    ],
    replace_words: REPLACE,
  };
}

function unavailable(guest, say) {
  return {
    intent: "installos",
    available: false,
    engine: "nix-template",
    cost: 1,
    guest,
    started: false,
    authority: "dios",
    model_cannot_confirm: true,
    host: "nix",
    scripts: [],
    say,
  };
}

function nameOk(name) {
  if (!name || name.length > 31 || name.endsWith(" ")) return false;
  let alnum = false;
  for (const c of name) {
    if ((c >= "a" && c <= "z") || (c >= "0" && c <= "9")) alnum = true;
    else if (c !== " " && c !== "." && c !== "_" && c !== "-") return false;
  }
  return alnum;
}

function pod(verb, name) {
  const lead = verb === "reinstall" ? `Replace pod ${name}? [y/n]`
    : verb === "launch" ? `Launch pod ${name}? [y/n]`
    : verb === "remove" ? `Remove pod ${name}? [y/n]`
    : `Install ${name} as a pod? [y/n]`;
  return {
    intent: "pod",
    available: true,
    engine: "nix-template",
    cost: 1,
    verb,
    name,
    starts_container: false,
    authority: "dios",
    model_cannot_confirm: true,
    confirm: [lead, "Confirm as dios? [y/n]"],
    scripts: [],
    say: "A container runtime is not in this kernel, so it is not started.",
  };
}

function withAgain(words) {
  if (words.length === 0) return { again: false, error: "" };
  if (words.length === 1 && REPLACE.includes(words[0])) return { again: true, error: "" };
  return { again: false, error: "intent_invalid" };
}

export function serveIntent(text) {
  const raw = clean(text);
  if (!raw) return { error: "intent_required" };
  if (raw.length > 180) return { error: "intent_too_long" };

  let reachHost = "";
  const reachMatch = /^(?:is\s+(\S+)\s+up|ping\s+(\S+)|whois\s+(\S+)|check\s+(\S+))$/.exec(raw);
  if (reachMatch) reachHost = reachMatch.slice(1).find(Boolean);
  if (reachHost) {
    const host = reachHost.replace(/^https?:\/\//, "").replace(/\/$/, "");
    if (!hostOk(host)) return { error: "intent_invalid" };
    return { cost: 1, body: reach(host) };
  }

  if (raw.startsWith("intent ")) {
    const match = /^intent\s+(install|reinstall|launch|remove)\s+(.+)$/.exec(raw);
    if (!match || !nameOk(match[2])) return { error: "intent_invalid" };
    const body = pod(match[1], match[2]);
    return { cost: body.cost, body };
  }

  let rest = raw.startsWith("ask ") ? raw.slice(4).trim() : raw;
  if (rest.startsWith("install ")) rest = rest.slice(8).trim();
  const words = rest.split(/\s+/).filter(Boolean);
  const name = words[0] || "";
  if (name === "windows") {
    let tail = words.slice(1);
    let version = "";
    if (tail[0] && /^\d{1,2}$/.test(tail[0])) {
      version = tail[0];
      tail = tail.slice(1);
    }
    const flag = withAgain(tail);
    if (flag.error) return { error: flag.error };
    const body = unavailable("windows", "Windows is not built in this kernel, so it was not started.");
    if (version) body.version = version;
    return { cost: 1, body };
  }
  const known = name === "kernel" || name === "bsd" || name === "freebsd" || Boolean(GUESTS[name]);
  if (!known) return { error: "intent_unknown" };
  const again = withAgain(words.slice(1));
  if (again.error) return { error: again.error };
  if (name === "kernel") return { cost: 1, body: kernel(again.again) };
  if (name === "bsd" || name === "freebsd") {
    const body = unavailable("bsd", "NIX is not Linux. BSD is not Linux 7.3.1. A FreeBSD kernel is not built, so it was not started.");
    return { cost: 1, body };
  }
  return { cost: 1, body: installos(name, again.again) };
}

export function publicIntents() {
  return [
    { id: "reach", cost: 1, example: "is google.com up?", runs_on: "host" },
    { id: "installos", cost: 1, guests: ["debian", "ubuntu", "centos"], example: "ask ubuntu", marker: "NIX_BOOT_GUEST" },
    { id: "kernel", cost: 1, example: "ask kernel", marker: "NIX_BUILD_KERNEL linux-7.3.1" },
    { id: "pod", cost: 1, example: "intent install editor", starts_container: false },
  ];
}
