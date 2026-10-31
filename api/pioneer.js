import { HttpError } from "./validate.js";
import { fingerprint, reserve, complete, refund } from "./pioneer-ledger.js";

const HEADERS = { "cache-control": "no-store" };
const POLICY = { credits_per_request: 1, max_output_tokens: 4096, max_request_bytes: 131072 };

export async function parseCompletion(request) {
  // Bound streamed bodies too; Content-Length alone is not a limit.
  const reader = request.body?.getReader();
  if (!reader) throw new HttpError(400, "body_required");
  const chunks = []; let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > POLICY.max_request_bytes) { await reader.cancel(); throw new HttpError(413, "request_too_large"); }
    chunks.push(value);
  }
  const data = new Uint8Array(size); let at = 0;
  for (const chunk of chunks) { data.set(chunk, at); at += chunk.byteLength; }
  let body;
  try { body = JSON.parse(new TextDecoder().decode(data)); }
  catch { throw new HttpError(400, "invalid_json"); }
  if (body?.model !== "pioneer") throw new HttpError(400, "pioneer_model_required");
  if (!Array.isArray(body.messages) || !body.messages.length || body.messages.length > 128)
    throw new HttpError(400, "invalid_messages");
  const roles = new Set(["system", "user", "assistant", "tool"]);
  for (const message of body.messages) {
    if (Array.isArray(message?.content)) {
      if (message.content.some(part => part?.type !== "text" || typeof part.text !== "string"))
        throw new HttpError(400, "text_messages_required");
      message.content = message.content.map(part => part.text).join("\n");
    }
    if (!message || !roles.has(message.role) ||
        (message.content !== null && typeof message.content !== "string"))
      throw new HttpError(400, "text_messages_required");
    if (message.role === "tool" && typeof message.tool_call_id !== "string")
      throw new HttpError(400, "tool_call_id_required");
  }
  if (body.tools !== undefined && (!Array.isArray(body.tools) || body.tools.length > 64 ||
      body.tools.some(t => t?.type !== "function" || typeof t.function?.name !== "string")))
    throw new HttpError(400, "invalid_tools");
  const maximum = body.max_tokens ?? body.max_completion_tokens ?? POLICY.max_output_tokens;
  if (!Number.isInteger(maximum) || maximum < 1 || maximum > POLICY.max_output_tokens)
    throw new HttpError(400, "invalid_output_limit");
  return {
    stream: body.stream === true,
    input: { messages: body.messages, ...(body.tools?.length ? { tools: body.tools } : {}),
      max_tokens: maximum, temperature: 0.2, reasoning_effort: "low", stream: false },
  };
}

export function completionResponse(response, stream) {
  if (!stream) return Response.json(response, { headers: HEADERS });
  const choice = response.choices[0];
  const message = choice.message;
  const base = { id: response.id, object: "chat.completion.chunk", created: response.created, model: "pioneer" };
  const chunks = [{ ...base, choices: [{ index: 0, delta: {
    role: "assistant", ...(message.content ? { content: message.content } : {}),
    ...(message.tool_calls?.length ? { tool_calls: message.tool_calls.map((tool, index) => ({ index, ...tool })) } : {}),
  }, finish_reason: null }] },
  { ...base, choices: [{ index: 0, delta: {}, finish_reason: choice.finish_reason }], usage: response.usage }];
  const wire = chunks.map(c => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n";
  return new Response(wire, { headers: { ...HEADERS, "content-type": "text/event-stream; charset=utf-8" } });
}

export async function pioneerRoute(request, env, path, loadAccess, getAgent) {
  const access = await loadAccess(request, env);
  // Sandbox/test gateway purchases must never authorize production inference.
  if (!access.authnet_transaction_id || access.authnet_transaction_id.startsWith("test:"))
    throw new HttpError(402, "paid_token_required");
  if (request.method === "GET" && path === "/intent/v1/models")
    return Response.json({ object: "list", data: [{ id: "pioneer", object: "model", owned_by: "nix" }] }, { headers: HEADERS });
  if (request.method === "GET" && path === "/intent/v1/account")
    return Response.json({ model: "pioneer", credits: Number(access.units || 0), plan: access.plan,
      policy: POLICY, purchase: "/api/v1/units" }, { headers: HEADERS });
  if (path !== "/intent/v1/chat/completions") throw new HttpError(404, "not_found");
  if (request.method !== "POST") throw new HttpError(405, "method_not_allowed");
  if (!env.PIONEER || !env.AI) throw new HttpError(503, "pioneer_unavailable");
  const key = request.headers.get("idempotency-key");
  if (!key || !/^[A-Za-z0-9._:-]{16,128}$/.test(key)) throw new HttpError(400, "idempotency_key_required");
  const { input, stream } = await parseCompletion(request);
  const reservation = await reserve(env.DB, access.subscription_id, key, await fingerprint(JSON.stringify(input)));
  if (reservation.cached) return completionResponse(reservation.cached, stream);
  try {
    const agent = await getAgent(access.subscription_id);
    const reply = await agent.fetch(new Request("https://pioneer.internal/infer", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input),
    }));
    if (!reply.ok) {
      console.error(JSON.stringify({ event: "pioneer_agent_error", status: reply.status }));
      throw new Error("Pioneer inference failed");
    }
    const result = await reply.json();
    const response = completionResponse(result, stream);
    await complete(env.DB, reservation, result);
    return response;
  } catch (error) {
    console.error(JSON.stringify({ event: "pioneer_request_failed", name: error.name }));
    const refunded = await refund(env.DB, reservation);
    throw new HttpError(502, "pioneer_failed", { refunded });
  }
}
