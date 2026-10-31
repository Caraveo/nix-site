import { HttpError } from "./validate.js";
import { PRICE, transactionHashValid } from "./token.js";

const DEFAULT_URL = "https://api.authorize.net/xml/v1/request.api";

function unwrap(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) return data;
  const keys = Object.keys(data);
  if (keys.length === 1 && keys[0].endsWith("Response")) return data[keys[0]];
  return data;
}

function messagesOf(data) {
  const raw = data?.messages?.message;
  const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
  return {
    ok: data?.messages?.resultCode === "Ok",
    code: String(list[0]?.code || ""),
    text: String(list[0]?.text || "").slice(0, 180),
  };
}

function redact(env, text) {
  let out = String(text || "");
  for (const secret of [env.AUTHNET_TRANSACTION_KEY, env.AUTHNET_SIGNATURE_KEY, env.AUTHNET_API_LOGIN_ID]) {
    if (secret) out = out.split(secret).join("[redacted]");
  }
  return out.slice(0, 180);
}

export async function gateway(env, body) {
  const response = await fetch(env.AUTHNET_API_URL || DEFAULT_URL, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(body),
  });
  let text = await response.text();
  if (text.charCodeAt(0) === 0xfeff || text.startsWith("\uFEFF")) text = text.slice(1);
  try {
    return unwrap(JSON.parse(text));
  } catch {
    throw new HttpError(502, "gateway_unavailable");
  }
}

function auth(env) {
  return {
    name: env.AUTHNET_API_LOGIN_ID,
    transactionKey: env.AUTHNET_TRANSACTION_KEY,
  };
}

export async function chargeOpaque(env, { refId, opaque, billTo, customerId, amount, description }) {
  const price = String(amount || PRICE);
  if (!/^\d+\.\d{2}$/.test(price)) throw new HttpError(500, "misconfigured");
  const data = await gateway(env, {
    createTransactionRequest: {
      merchantAuthentication: auth(env),
      refId,
      transactionRequest: {
        transactionType: "authCaptureTransaction",
        amount: price,
        payment: { opaqueData: opaque },
        order: { invoiceNumber: refId, description: description || "NIX ask" },
        customer: { id: customerId },
        billTo,
      },
    },
  });
  const transaction = data.transactionResponse || {};
  const message = messagesOf(data);
  const decision = approvedTransaction(transaction);
  if (!decision) {
    const error = Array.isArray(transaction.errors) ? transaction.errors[0] : transaction.errors;
    throw new HttpError(402, "payment_declined", {
      gateway_code: String(error?.errorCode || message.code || ""),
      gateway_message: redact(env, error?.errorText || message.text || "declined"),
    });
  }
  const candidates = [transaction.amount, data.amount, price, Number(price).toFixed(4)];
  let matchedAmount = "";
  for (const candidate of [...new Set(candidates.filter((value) => value != null).map(String))]) {
    if (await transactionHashValid(env.AUTHNET_SIGNATURE_KEY, env.AUTHNET_API_LOGIN_ID, decision.transId, candidate, transaction.transHashSha2)) {
      matchedAmount = candidate;
      break;
    }
  }
  if (!matchedAmount) throw new HttpError(502, "payment_unconfirmed", { reference: refId });
  const account = String(transaction.accountNumber || "");
  const last4 = account.match(/(\d{4})$/)?.[1] || "";
  return {
    transId: decision.testMode ? storedTestTransId(refId) : decision.transId,
    gatewayTransId: decision.transId,
    testMode: decision.testMode,
    brand: String(transaction.accountType || ""),
    last4,
    amount: matchedAmount,
  };
}

export function approvedTransaction(transaction) {
  const responseCode = String(transaction?.responseCode || "");
  const transId = String(transaction?.transId ?? "");
  const testRequest = String(transaction?.testRequest ?? "").toLowerCase();
  if (responseCode !== "1" || transId === "") return null;
  if (transId === "0") {
    if (testRequest !== "1" && testRequest !== "true") return null;
    return { testMode: true, transId };
  }
  return { testMode: false, transId };
}

function storedTestTransId(refId) {
  if (!/^[A-Za-z0-9]{8,32}$/.test(String(refId || ""))) throw new HttpError(500, "misconfigured");
  return `test:${refId}`;
}

export async function profileFromTransaction(env, transId) {
  if (!transId || transId === "0" || String(transId).startsWith("test:")) return null;
  const data = await gateway(env, {
    createCustomerProfileFromTransactionRequest: {
      merchantAuthentication: auth(env),
      transId,
    },
  });
  const message = messagesOf(data);
  if (!message.ok || !data.customerProfileId) return null;
  const list = data.customerPaymentProfileIdList || data.customerPaymentProfileIds || [];
  const paymentProfileId = Array.isArray(list) ? list[0] : list;
  if (!paymentProfileId) return null;
  return {
    customerProfileId: String(data.customerProfileId),
    paymentProfileId: String(paymentProfileId),
  };
}

export async function createSubscription(env, { refId, profile, startDate }) {
  const data = await gateway(env, {
    ARBCreateSubscriptionRequest: {
      merchantAuthentication: auth(env),
      refId,
      subscription: {
        name: "NIX ask",
        paymentSchedule: {
          interval: { length: "31", unit: "days" },
          startDate,
          totalOccurrences: "9999",
        },
        amount: PRICE,
        profile: {
          customerProfileId: profile.customerProfileId,
          customerPaymentProfileId: profile.paymentProfileId,
        },
      },
    },
  });
  const message = messagesOf(data);
  const subscriptionId = String(data.subscriptionId || "");
  if (!message.ok || !subscriptionId || subscriptionId === "0") {
    return { id: "", note: redact(env, message.text || message.code || "renewal_not_scheduled") };
  }
  return { id: subscriptionId, note: "" };
}

export async function cancelSubscription(env, subscriptionId) {
  const data = await gateway(env, {
    ARBCancelSubscriptionRequest: {
      merchantAuthentication: auth(env),
      subscriptionId,
    },
  });
  const message = messagesOf(data);
  if (!message.ok) throw new HttpError(502, "cancel_failed", { gateway_message: redact(env, message.text) });
}

export async function transactionSubscriptionId(env, transId) {
  const data = await gateway(env, {
    getTransactionDetailsRequest: {
      merchantAuthentication: auth(env),
      transId,
    },
  });
  const subscription = data.transaction?.subscription;
  return subscription?.id ? String(subscription.id) : "";
}
