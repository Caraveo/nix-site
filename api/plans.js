import { HttpError } from "./validate.js";

const DAY = 24 * 60 * 60 * 1000;

export const LIFETIME_THROUGH = Date.UTC(9999, 0, 1);

export const PLANS = {
  month: {
    id: "month",
    amount: "2.99",
    days: 31,
    rank: 1,
    recurring: true,
    prefix: "",
    cipher: "hmac-sha256",
    included: 25,
  },
  year: {
    id: "year",
    amount: "35.88",
    days: 365,
    rank: 2,
    recurring: false,
    prefix: "y1.",
    bodyChars: 256,
    planByte: 1,
    hash: "SHA-384",
    macBytes: 48,
    cipher: "aes-256-gcm+hmac-sha384",
    included: 300,
  },
  year5: {
    id: "year5",
    amount: "179.40",
    days: 1825,
    rank: 3,
    recurring: false,
    prefix: "y5.",
    bodyChars: 256,
    planByte: 5,
    hash: "SHA-512",
    macBytes: 64,
    cipher: "aes-256-gcm+hmac-sha512",
    included: 1500,
  },
  year10: {
    id: "year10",
    amount: "358.80",
    days: 3650,
    rank: 4,
    recurring: false,
    prefix: "ya.",
    bodyChars: 384,
    planByte: 10,
    hash: "SHA-512",
    macBytes: 64,
    cipher: "aes-256-gcm+hkdf-sha512+hmac-sha512",
    included: 3000,
  },
  lifetime: {
    id: "lifetime",
    amount: "500.00",
    days: null,
    rank: 5,
    recurring: false,
    prefix: "lt.",
    bodyChars: 512,
    planByte: 255,
    hash: "SHA-512",
    macBytes: 64,
    cipher: "aes-256-gcm+hkdf-sha512+hmac-sha512",
    included: 5000,
  },
};

const ALIASES = {
  month: "month",
  monthly: "month",
  year: "year",
  "1y": "year",
  "1year": "year",
  annual: "year",
  year5: "year5",
  "5y": "year5",
  "5year": "year5",
  year10: "year10",
  "10y": "year10",
  "10year": "year10",
  lifetime: "lifetime",
  life: "lifetime",
  forever: "lifetime",
};

export function planById(id) {
  return PLANS[id] || PLANS.month;
}

export function requirePlan(value) {
  if (value == null || value === "") return PLANS.month;
  const id = ALIASES[String(value).trim().toLowerCase()];
  if (!id) throw new HttpError(400, "unknown_plan");
  return PLANS[id];
}

export function planFromToken(token) {
  if (typeof token !== "string") return null;
  if (/^[A-Za-z0-9_-]{256}$/.test(token)) return PLANS.month;
  for (const plan of Object.values(PLANS)) {
    if (plan.prefix && token.startsWith(plan.prefix) && token.length === plan.prefix.length + plan.bodyChars) {
      return plan;
    }
  }
  return null;
}

export function paidUntil(plan, now) {
  return plan.days ? now + plan.days * DAY : LIFETIME_THROUGH;
}

export function showExpiry(plan, ms) {
  return plan.days ? new Date(ms).toISOString() : null;
}

export function publicPlans() {
  return Object.values(PLANS).map((plan) => ({
    id: plan.id,
    amount: plan.amount,
    currency: "USD",
    interval_days: plan.days,
    lifetime: !plan.days,
    recurring: plan.recurring,
    cipher: plan.cipher,
    included_units: plan.included,
  }));
}
