export const PERIOD_MS = 31 * 24 * 60 * 60 * 1000;
export const PRICE = "2.99";
export const TOKEN_BYTES = 192;

export function mintToken() {
  const bytes = new Uint8Array(TOKEN_BYTES);
  crypto.getRandomValues(bytes);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

export function hexToBytes(hex) {
  if (!/^[0-9a-fA-F]+$/.test(hex) || hex.length % 2) {
    throw new Error("bad_hex");
  }
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function bytesToHex(bytes) {
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function hmacHex(algorithm, keyBytes, message) {
  const key = await crypto.subtle.importKey(
    "raw",
    keyBytes,
    { name: "HMAC", hash: algorithm },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return bytesToHex(signature);
}

export async function tokenHash(pepperHex, token) {
  return hmacHex("SHA-256", hexToBytes(pepperHex), token);
}

export function timingSafeEqual(left, right) {
  const a = new TextEncoder().encode(left);
  const b = new TextEncoder().encode(right);
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

export async function webhookSignatureValid(signatureKeyHex, rawBody, header) {
  if (!header || !signatureKeyHex) return false;
  const expected = await hmacHex("SHA-512", hexToBytes(signatureKeyHex), rawBody);
  const presented = header.trim().toLowerCase().replace(/^sha512=/, "");
  return timingSafeEqual(expected.toLowerCase(), presented);
}

export async function transactionHashValid(signatureKeyHex, loginId, transId, amount, presented) {
  if (!presented) return false;
  const message = `^${loginId}^${transId}^${amount}^`;
  const expected = await hmacHex("SHA-512", hexToBytes(signatureKeyHex), message);
  return timingSafeEqual(expected.toLowerCase(), String(presented).trim().toLowerCase());
}

export function arbStartDate(now = Date.now()) {
  return new Date(now + PERIOD_MS).toISOString().slice(0, 10);
}
