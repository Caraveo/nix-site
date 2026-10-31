import { planFromToken } from "./plans.js";
import { hexToBytes, hmacHex, tokenHash } from "./token.js";

const MAGIC = "NIXASK01";

function bytesToBase64url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function base64urlToBytes(text) {
  const padded = text + "=".repeat((4 - (text.length % 4)) % 4);
  const binary = atob(padded.replaceAll("-", "+").replaceAll("_", "/"));
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

async function hkdf(pepperHex, info, length, hash) {
  const key = await crypto.subtle.importKey("raw", hexToBytes(pepperHex), { name: "HKDF" }, false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    {
      name: "HKDF",
      hash,
      salt: new TextEncoder().encode("nix-ask-v1"),
      info: new TextEncoder().encode(info),
    },
    key,
    length * 8,
  );
  return new Uint8Array(bits);
}

async function aesKey(pepperHex, plan) {
  const raw = await hkdf(pepperHex, `nix-ask-aes-${plan.id}`, 32, "SHA-512");
  return crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

export async function sealToken(pepperHex, plan, kind) {
  const rawLength = (plan.bodyChars * 3) / 4;
  const plain = new Uint8Array(rawLength - 28);
  crypto.getRandomValues(plain);
  plain.set(new TextEncoder().encode(MAGIC), 0);
  plain[8] = plan.planByte;
  plain[9] = kind === "refresh" ? 2 : 1;
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await aesKey(pepperHex, plan), plain));
  const packed = new Uint8Array(iv.length + encrypted.length);
  packed.set(iv, 0);
  packed.set(encrypted, iv.length);
  return plan.prefix + bytesToBase64url(packed);
}

export async function openToken(pepperHex, token) {
  const plan = planFromToken(token);
  if (!plan?.prefix) return null;
  try {
    const packed = base64urlToBytes(token.slice(plan.prefix.length));
    const plain = new Uint8Array(
      await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: packed.slice(0, 12) },
        await aesKey(pepperHex, plan),
        packed.slice(12),
      ),
    );
    if (new TextDecoder().decode(plain.slice(0, 8)) !== MAGIC || plain[8] !== plan.planByte) return null;
    return { plan, kind: plain[9] === 2 ? "refresh" : "access" };
  } catch {
    return null;
  }
}

export async function cipherMac(pepperHex, plan, message) {
  const macKey = await hkdf(pepperHex, `nix-ask-mac-${plan.id}`, plan.macBytes, plan.hash);
  return hmacHex(plan.hash, macKey, message);
}

export function macHexLength(plan) {
  return plan.macBytes * 2;
}

export async function tokenMac(pepperHex, plan, kind, token) {
  if (!plan?.prefix) return tokenHash(pepperHex, `${kind}:${token}`);
  const opened = await openToken(pepperHex, token);
  if (!opened || opened.kind !== kind || opened.plan.id !== plan.id) return null;
  return cipherMac(pepperHex, plan, `${kind}:${token}`);
}
