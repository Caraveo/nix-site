const CARD_KEYS = new Set([
  "card_number",
  "cardnumber",
  "pan",
  "cvv",
  "cvc",
  "cid",
  "expiration",
  "expirationdate",
  "expiry",
  "accountnumber",
]);

export class HttpError extends Error {
  constructor(status, code, extra) {
    super(code);
    this.status = status;
    this.code = code;
    this.extra = extra || {};
  }
}

export function rejectCardFields(value) {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const item of value) rejectCardFields(item);
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    if (CARD_KEYS.has(key.toLowerCase().replaceAll("-", "").replaceAll("_", ""))) {
      throw new HttpError(400, "card_data_not_accepted");
    }
    rejectCardFields(child);
  }
}

export function requireOpaqueData(body) {
  const opaque = body?.opaque_data;
  const descriptor = String(opaque?.data_descriptor || "");
  const value = String(opaque?.data_value || "");
  if (descriptor !== "COMMON.ACCEPT.INAPP.PAYMENT" || value.length < 20 || value.length > 20000) {
    throw new HttpError(400, "opaque_data_required");
  }
  if (/^\d{13,19}$/.test(value)) throw new HttpError(400, "card_data_not_accepted");
  return { dataDescriptor: descriptor, dataValue: value };
}

export function requireDeviceId(value) {
  const deviceId = String(value || "");
  if (!/^[A-Za-z0-9_-]{32,256}$/.test(deviceId)) {
    throw new HttpError(400, "device_id_required");
  }
  return deviceId;
}

export function requireIdempotencyKey(value) {
  const key = String(value || "");
  if (!/^[A-Za-z0-9_-]{16,80}$/.test(key)) {
    throw new HttpError(400, "idempotency_key_required");
  }
  return key;
}

export function requireName(value, code) {
  const name = String(value || "").trim();
  if (!/^[\p{L}][\p{L} .'-]{0,49}$/u.test(name)) throw new HttpError(400, code);
  return name;
}

export function requirePostal(value) {
  const postal = String(value || "").trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9 -]{1,11}$/.test(postal)) {
    throw new HttpError(400, "postal_code_required");
  }
  return postal;
}

export function optionalCountry(value) {
  const country = String(value || "US").trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(country)) throw new HttpError(400, "country_invalid");
  return country;
}
