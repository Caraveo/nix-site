import { Agent } from "agents";

// This class has no public route or callable methods. Only the authenticated,
// credit-reserving Worker uses its private Durable Object binding.
export class PioneerAgent extends Agent {
  async onRequest(request) {
    if (request.method !== "POST" || new URL(request.url).pathname !== "/infer")
      return new Response("Not found", { status: 404 });
    const input = await request.json();
    let output;
    try {
      output = await this.env.AI.run("@cf/qwen/qwen3.8-27b", input);
    } catch (error) {
      // Log no prompts, request headers, credentials, or provider error bodies.
      console.error(JSON.stringify({ event: "pioneer_model_error", name: error.name,
        code: typeof error.code === "number" ? error.code : null }));
      return Response.json({ error: "model_inference_failed" }, { status: 502 });
    }
    const original = output.choices?.[0]?.message;
    const calls = original?.tool_calls ?? output.tool_calls ?? [];
    const tools = calls.map((call, index) => ({
      id: call.id || `call_${crypto.randomUUID()}`,
      type: "function",
      function: { name: call.function?.name ?? call.name,
        arguments: typeof (call.function?.arguments ?? call.arguments) === "string"
          ? (call.function?.arguments ?? call.arguments)
          : JSON.stringify(call.function?.arguments ?? call.arguments ?? {}) },
    }));
    const text = original?.content ?? output.response ?? "";
    if (typeof text !== "string" || (!text && !tools.length)) {
      console.error(JSON.stringify({ event: "pioneer_empty_output", keys: Object.keys(output),
        finish_reason: output.choices?.[0]?.finish_reason ?? null }));
      return Response.json({ error: "empty_model_output" }, { status: 502 });
    }
    return Response.json({ id: `chatcmpl-${crypto.randomUUID()}`, object: "chat.completion",
      created: Math.floor(Date.now() / 1000), model: "pioneer",
      choices: [{ index: 0, message: { role: "assistant", content: text || null,
        ...(tools.length ? { tool_calls: tools } : {}) },
        finish_reason: tools.length ? "tool_calls" : (output.choices?.[0]?.finish_reason ?? "stop") }],
      usage: output.usage ?? {},
    });
  }
}
