import { Router } from 'itty-router';
import { Agent, getAgentByName } from 'agents';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { z } from 'zod';
export { z } from 'zod';

var __defProp = Object.defineProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};

// runtime/providers/chat-completions.ts
function toOA(req) {
  const msgs = [];
  if (req.systemPrompt)
    msgs.push({ role: "system", content: req.systemPrompt });
  for (const m of req.messages) {
    if (m.role === "tool") {
      msgs.push({
        role: "tool",
        content: m.content ?? "",
        tool_call_id: m.toolCallId
      });
    } else if (m.role === "assistant" && "toolCalls" in m && m.toolCalls?.length) {
      msgs.push({
        role: "assistant",
        content: "",
        tool_calls: m.toolCalls.map(({ id, name, args }) => ({
          id,
          type: "function",
          function: {
            name,
            arguments: typeof args === "string" ? args : JSON.stringify(args ?? {})
          }
        }))
      });
    } else if ("content" in m) {
      msgs.push({ role: m.role, content: m.content ?? "" });
    }
  }
  const tools = (req.toolDefs ?? []).map((t) => ({
    type: "function",
    function: {
      name: t.name,
      description: t.description ?? void 0,
      parameters: t.parameters ?? {
        type: "object",
        properties: {},
        additionalProperties: true
      }
    }
  }));
  return {
    model: parseModel(req.model),
    messages: msgs,
    temperature: req.temperature,
    max_tokens: req.maxTokens,
    stop: req.stop,
    tools,
    tool_choice: req.toolChoice ?? "auto"
  };
}
function safeParseJSON(str) {
  try {
    return JSON.parse(str);
  } catch {
    return str;
  }
}
function fromOA(choice) {
  const msg = choice?.message ?? {};
  if ("tool_calls" in msg && msg?.tool_calls?.length) {
    return {
      role: "assistant",
      reasoning: msg.reasoning,
      toolCalls: msg.tool_calls.map((tc) => ({
        id: tc.id,
        name: tc.function?.name,
        args: safeParseJSON(tc.function?.arguments ?? "{}")
      }))
    };
  }
  return { role: "assistant", reasoning: msg?.reasoning, content: msg?.content ?? "" };
}
function sleep(ms, signal) {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    const abortError = new Error("Request aborted");
    abortError.name = "AbortError";
    if (signal?.aborted) {
      clearTimeout(timer);
      return reject(abortError);
    }
    if (signal) {
      signal.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          reject(abortError);
        },
        { once: true }
      );
    }
  });
}
function parseRetryAfterMs(value) {
  if (!value) return null;
  const seconds = Number.parseFloat(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1e3);
  const dateMs = Date.parse(value);
  if (!Number.isNaN(dateMs)) {
    const diff = dateMs - Date.now();
    return diff > 0 ? diff : 0;
  }
  return null;
}
function computeDelayMs(attempt, retry, retryAfterMs) {
  let delay = retryAfterMs ?? Math.min(retry.maxBackoffMs, retry.backoffMs * 2 ** attempt);
  if (retry.jitterRatio > 0) {
    const jitter = delay * retry.jitterRatio;
    delay += (Math.random() * 2 - 1) * jitter;
  }
  return Math.max(0, Math.round(delay));
}
function isAbortError(error) {
  return error instanceof Error && error.name === "AbortError";
}
var NonRetryableError = class extends Error {
  constructor() {
    super(...arguments);
    this.retryable = false;
  }
};
function makeChatCompletions(apiKey, baseUrl = "https://api.openai.com/v1", options = {}) {
  const headers = {
    "content-type": "application/json",
    authorization: `Bearer ${apiKey}`
  };
  const retry = options.retry && options.retry.maxRetries > 0 ? options.retry : null;
  return {
    async invoke(req, { signal }) {
      const body = toOA(req);
      const payload = JSON.stringify({ ...body, stream: false });
      for (let attempt = 0; ; attempt++) {
        try {
          const res = await fetch(`${baseUrl}/chat/completions`, {
            method: "POST",
            headers,
            body: payload,
            signal
          });
          if (!res.ok) {
            const retryAfterMs = parseRetryAfterMs(
              res.headers.get("Retry-After")
            );
            if (retry && retry.retryableStatusCodes.includes(res.status) && attempt < retry.maxRetries) {
              await sleep(computeDelayMs(attempt, retry, retryAfterMs), signal);
              continue;
            }
            const errTxt = await res.text().catch(() => "");
            throw new NonRetryableError(
              `Chat completions error ${res.status}: ${errTxt}`
            );
          }
          const json = await res.json();
          const message = fromOA(json.choices?.[0]);
          const usage = json.usage ? {
            promptTokens: json.usage.prompt_tokens,
            completionTokens: json.usage.completion_tokens
          } : void 0;
          return { message, usage };
        } catch (error) {
          if (signal?.aborted || isAbortError(error)) {
            throw error;
          }
          if (retry && attempt < retry.maxRetries && !(error instanceof NonRetryableError)) {
            await sleep(computeDelayMs(attempt, retry, null), signal);
            continue;
          }
          throw error;
        }
      }
    },
    async stream(req, onDelta) {
      const body = toOA(req);
      const payload = JSON.stringify({ ...body, stream: true, stream_options: { include_usage: true } });
      const res = await fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers,
        body: payload
      });
      if (!res.ok) {
        const errTxt = await res.text().catch(() => "");
        throw new NonRetryableError(
          `Chat completions stream error ${res.status}: ${errTxt}`
        );
      }
      let contentAcc = "";
      let reasoningAcc = "";
      const toolCallsAcc = [];
      let usage;
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || !trimmed.startsWith("data: ")) continue;
          const data = trimmed.slice(6);
          if (data === "[DONE]") continue;
          let parsed;
          try {
            parsed = JSON.parse(data);
          } catch {
            continue;
          }
          if (parsed.usage) {
            usage = parsed.usage;
          }
          const choice = parsed.choices?.[0];
          if (!choice) continue;
          const delta = choice.delta;
          if (!delta) continue;
          if (delta.content) {
            contentAcc += delta.content;
            onDelta(delta.content);
          }
          if (delta.reasoning) {
            reasoningAcc += delta.reasoning;
          }
          if (delta.tool_calls) {
            for (const tc of delta.tool_calls) {
              const idx = tc.index ?? 0;
              if (!toolCallsAcc[idx]) {
                toolCallsAcc[idx] = {
                  index: idx,
                  id: tc.id ?? "",
                  name: tc.function?.name ?? "",
                  arguments: tc.function?.arguments ?? ""
                };
              } else {
                if (tc.id) toolCallsAcc[idx].id = tc.id;
                if (tc.function?.name) toolCallsAcc[idx].name += tc.function.name;
                if (tc.function?.arguments) toolCallsAcc[idx].arguments += tc.function.arguments;
              }
            }
          }
        }
      }
      let message;
      if (toolCallsAcc.length > 0) {
        message = {
          role: "assistant",
          reasoning: reasoningAcc || void 0,
          toolCalls: toolCallsAcc.map((tc) => ({
            id: tc.id,
            name: tc.name,
            args: safeParseJSON(tc.arguments)
          }))
        };
      } else {
        message = {
          role: "assistant",
          reasoning: reasoningAcc || void 0,
          content: contentAcc
        };
      }
      return {
        message,
        usage: usage ? {
          promptTokens: usage.prompt_tokens,
          completionTokens: usage.completion_tokens
        } : void 0
      };
    }
  };
}

// runtime/providers/test.ts
var TestProvider = class {
  constructor() {
    /** All requests made to this provider */
    this.requests = [];
    /** Queued responses to return */
    this.responses = [];
    /** Tool call expectations for validation */
    this.toolCallExpectations = [];
    /** Recorded tool calls for assertions */
    this.toolCalls = [];
  }
  /**
   * Add a response to the queue.
   * Responses are returned in FIFO order.
   */
  addResponse(response) {
    this.responses.push(response);
    return this;
  }
  /**
   * Add multiple responses to the queue.
   */
  addResponses(...responses) {
    this.responses.push(...responses);
    return this;
  }
  /**
   * Set a dynamic response handler.
   * Called when the response queue is empty.
   */
  onRequest(handler) {
    this.responseHandler = handler;
    return this;
  }
  /**
   * Set expected tool calls for validation.
   * Call `assertExpectations()` to verify they were made.
   */
  expectToolCalls(...expectations) {
    this.toolCallExpectations.push(...expectations);
    return this;
  }
  /**
   * Assert that all expected tool calls were made.
   * Throws if expectations weren't met.
   */
  assertExpectations() {
    for (const expectation of this.toolCallExpectations) {
      const found = this.toolCalls.find((tc) => {
        if (tc.name !== expectation.name) return false;
        if (!expectation.args) return true;
        if (typeof expectation.args === "function") {
          return expectation.args(tc.args);
        }
        const tcArgs = tc.args;
        for (const [key, value] of Object.entries(expectation.args)) {
          if (JSON.stringify(tcArgs[key]) !== JSON.stringify(value)) {
            return false;
          }
        }
        return true;
      });
      if (!found) {
        const argsDesc = expectation.args && typeof expectation.args !== "function" ? ` with args ${JSON.stringify(expectation.args)}` : "";
        throw new Error(
          `Expected tool call "${expectation.name}"${argsDesc} was not made. Actual tool calls: ${JSON.stringify(this.toolCalls.map((tc) => tc.name))}`
        );
      }
    }
  }
  /**
   * Reset the provider state.
   * Clears requests, responses, and expectations.
   */
  reset() {
    this.requests.length = 0;
    this.responses.length = 0;
    this.toolCalls.length = 0;
    this.toolCallExpectations.length = 0;
    this.responseHandler = void 0;
    return this;
  }
  /**
   * Get the next response from the queue or handler.
   */
  getNextResponse(req) {
    if (this.responses.length > 0) {
      return this.responses.shift();
    }
    if (this.responseHandler) {
      return this.responseHandler(req);
    }
    throw new Error(
      `TestProvider: No response queued and no handler set. Request had ${req.messages.length} messages. Call addResponse() or onRequest() to provide responses.`
    );
  }
  /**
   * Convert a MockResponse to a ModelResult.
   */
  toResult(response) {
    if (typeof response === "object" && "message" in response) {
      const msg = response.message;
      if (msg.role === "assistant" && "toolCalls" in msg) {
        this.toolCalls.push(...msg.toolCalls);
      }
      return response;
    }
    if (typeof response === "object" && "toolCalls" in response) {
      this.toolCalls.push(...response.toolCalls);
      return {
        message: {
          role: "assistant",
          toolCalls: response.toolCalls
        },
        usage: { promptTokens: 0, completionTokens: 0 }
      };
    }
    return {
      message: {
        role: "assistant",
        content: response
      },
      usage: { promptTokens: 0, completionTokens: 0 }
    };
  }
  async invoke(req, _opts) {
    this.requests.push(structuredClone(req));
    const response = this.getNextResponse(req);
    return this.toResult(response);
  }
  async stream(req, onDelta) {
    this.requests.push(structuredClone(req));
    const response = this.getNextResponse(req);
    const result = this.toResult(response);
    const msg = result.message;
    if (msg.role === "assistant" && "content" in msg) {
      const content = msg.content;
      const chunkSize = 10;
      for (let i = 0; i < content.length; i += chunkSize) {
        onDelta(content.slice(i, i + chunkSize));
      }
    }
    return result;
  }
};
function createTestProvider(...responses) {
  const provider = new TestProvider();
  provider.addResponses(...responses);
  return provider;
}
function createEchoProvider() {
  const provider = new TestProvider();
  provider.onRequest((req) => {
    const lastUserMsg = [...req.messages].reverse().find((m) => m.role === "user");
    const content = lastUserMsg && "content" in lastUserMsg ? lastUserMsg.content : "(no message)";
    return `Echo: ${content}`;
  });
  return provider;
}
function createToolCallProvider(toolName, args = {}, callId = "call_1") {
  const provider = new TestProvider();
  provider.addResponse({
    toolCalls: [{ id: callId, name: toolName, args }]
  });
  return provider;
}

// runtime/providers/index.ts
function parseModel(m) {
  const idx = m.indexOf(":");
  return idx >= 0 ? m.slice(idx + 1) : m;
}
var CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "*",
  "Access-Control-Max-Age": "86400"
};
function secureCompare(a, b) {
  if (a === null) return false;
  const encoder = new TextEncoder();
  const aBytes = encoder.encode(a);
  const bBytes = encoder.encode(b);
  const maxLen = Math.max(aBytes.length, bBytes.length);
  let result = aBytes.length ^ bBytes.length;
  for (let i = 0; i < maxLen; i++) {
    const aByte = i < aBytes.length ? aBytes[i] : 0;
    const bByte = i < bBytes.length ? bBytes[i] : 0;
    result |= aByte ^ bByte;
  }
  return result === 0;
}
function createDoUrl(req, pathname) {
  const url = new URL(req.url);
  url.pathname = pathname;
  return url;
}
function withCors(response) {
  if (response.webSocket) {
    return response;
  }
  const newHeaders = new Headers(response.headers);
  for (const [key, value] of Object.entries(CORS_HEADERS)) {
    newHeaders.set(key, value);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: newHeaders
  });
}
var CF_CONTEXT_KEYS = [
  "colo",
  "country",
  "city",
  "region",
  "timezone",
  "postalCode",
  "asOrganization"
];
function buildRequestContext(req) {
  const headers = req.headers;
  const cf = req.cf ?? void 0;
  const context2 = {
    userAgent: headers.get("user-agent") ?? void 0,
    ip: headers.get("cf-connecting-ip") ?? void 0,
    referrer: headers.get("referer") ?? void 0,
    origin: headers.get("origin") ?? void 0
  };
  if (cf) {
    const filtered = {};
    for (const key of CF_CONTEXT_KEYS) {
      const value = cf[key];
      if (value !== void 0) filtered[key] = value;
    }
    if (Object.keys(filtered).length > 0) {
      context2.cf = filtered;
    }
  }
  return context2;
}
var getPlugins = (req, { opts }) => {
  return Response.json({
    plugins: opts.plugins || [],
    tools: opts.tools || []
  });
};
var listAgencies = async (req, { env }) => {
  const agencies = [];
  const list = await env.FS.list({ delimiter: "/" });
  for (const prefix of list.delimitedPrefixes) {
    const agencyName = prefix.replace(/\/$/, "");
    const metaObj = await env.FS.get(`${agencyName}/.agency.json`);
    if (metaObj) {
      try {
        const meta = await metaObj.json();
        agencies.push(meta);
      } catch {
        agencies.push({ id: agencyName, name: agencyName });
      }
    } else {
      agencies.push({ id: agencyName, name: agencyName });
    }
  }
  return Response.json({ agencies });
};
var createAgency = async (req, { env }) => {
  const body = await req.json().catch(() => ({}));
  const name = body.name?.trim();
  if (!name) {
    return new Response("Agency name is required", { status: 400 });
  }
  if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
    return new Response(
      "Agency name must be alphanumeric with dashes/underscores only",
      { status: 400 }
    );
  }
  const existing = await env.FS.head(`${name}/.agency.json`);
  if (existing) {
    return new Response(`Agency '${name}' already exists`, { status: 409 });
  }
  const meta = {
    id: name,
    name,
    createdAt: (/* @__PURE__ */ new Date()).toISOString()
  };
  await env.FS.put(`${name}/.agency.json`, JSON.stringify(meta));
  return Response.json(meta, { status: 201 });
};
async function getAgencyStub(agencyId, ctx) {
  const decodedId = decodeURIComponent(agencyId);
  return getAgentByName(ctx.exports.Agency, decodedId);
}
async function agencyExists(agencyId, env) {
  if (!env.FS) return true;
  const metaObj = await env.FS.head(`${agencyId}/.agency.json`);
  return metaObj !== null;
}
async function requireAgency(agencyId, env) {
  const decodedId = decodeURIComponent(agencyId);
  const exists = await agencyExists(decodedId, env);
  if (!exists) {
    return new Response(
      JSON.stringify({
        error: "Agency not found",
        message: `Agency '${decodedId}' does not exist. Create it first with POST /agencies`,
        agencyId: decodedId
      }),
      { status: 404, headers: { "content-type": "application/json" } }
    );
  }
  return null;
}
var deleteAgency = async (req, { ctx }) => {
  const agencyStub = await getAgencyStub(req.params.agencyId, ctx);
  return agencyStub.fetch(new Request(createDoUrl(req, "/destroy"), { method: "DELETE" }));
};
var listBlueprints = async (req, { ctx, opts }) => {
  const agencyStub = await getAgencyStub(req.params.agencyId, ctx);
  const res = await agencyStub.fetch(new Request(createDoUrl(req, "/blueprints")));
  if (!res.ok) return res;
  const dynamic = await res.json();
  const combined = /* @__PURE__ */ new Map();
  (opts.agentDefinitions || []).forEach((b) => combined.set(b.name, b));
  dynamic.blueprints.forEach((b) => combined.set(b.name, b));
  return Response.json({ blueprints: Array.from(combined.values()) });
};
var createBlueprint = async (req, { ctx }) => {
  const agencyStub = await getAgencyStub(req.params.agencyId, ctx);
  return agencyStub.fetch(new Request(createDoUrl(req, "/blueprints"), req));
};
var deleteBlueprint = async (req, { ctx }) => {
  const agencyStub = await getAgencyStub(req.params.agencyId, ctx);
  return agencyStub.fetch(
    new Request(createDoUrl(req, `/blueprints/${req.params.blueprintName}`), { method: "DELETE" })
  );
};
var listAgents = async (req, { ctx, env }) => {
  const notFound = await requireAgency(req.params.agencyId, env);
  if (notFound) return notFound;
  const agencyStub = await getAgencyStub(req.params.agencyId, ctx);
  return agencyStub.fetch(new Request(createDoUrl(req, "/agents")));
};
var createAgent = async (req, { ctx, env }) => {
  const notFound = await requireAgency(req.params.agencyId, env);
  if (notFound) return notFound;
  const agencyStub = await getAgencyStub(req.params.agencyId, ctx);
  const body = await req.json();
  body.requestContext = buildRequestContext(req);
  return agencyStub.fetch(
    new Request(createDoUrl(req, "/agents"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body)
    })
  );
};
var deleteAgent = async (req, { ctx }) => {
  const agencyStub = await getAgencyStub(req.params.agencyId, ctx);
  return agencyStub.fetch(
    new Request(createDoUrl(req, `/agents/${req.params.agentId}`), { method: "DELETE" })
  );
};
var getAgentTree = async (req, { ctx }) => {
  const agencyStub = await getAgencyStub(req.params.agencyId, ctx);
  return agencyStub.fetch(new Request(createDoUrl(req, `/agents/${req.params.agentId}/tree`)));
};
var getAgentForest = async (req, { ctx }) => {
  const agencyStub = await getAgencyStub(req.params.agencyId, ctx);
  return agencyStub.fetch(new Request(createDoUrl(req, "/agents/tree")));
};
var listSchedules = async (req, { ctx }) => {
  const agencyStub = await getAgencyStub(req.params.agencyId, ctx);
  return agencyStub.fetch(new Request(createDoUrl(req, "/schedules")));
};
var createSchedule = async (req, { ctx }) => {
  const agencyStub = await getAgencyStub(req.params.agencyId, ctx);
  return agencyStub.fetch(
    new Request(createDoUrl(req, "/schedules"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: req.body
    })
  );
};
var getSchedule = async (req, { ctx }) => {
  const agencyStub = await getAgencyStub(req.params.agencyId, ctx);
  return agencyStub.fetch(new Request(createDoUrl(req, `/schedules/${req.params.scheduleId}`)));
};
var updateSchedule = async (req, { ctx }) => {
  const agencyStub = await getAgencyStub(req.params.agencyId, ctx);
  return agencyStub.fetch(
    new Request(createDoUrl(req, `/schedules/${req.params.scheduleId}`), {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: req.body
    })
  );
};
var deleteSchedule = async (req, { ctx }) => {
  const agencyStub = await getAgencyStub(req.params.agencyId, ctx);
  return agencyStub.fetch(
    new Request(createDoUrl(req, `/schedules/${req.params.scheduleId}`), { method: "DELETE" })
  );
};
var pauseSchedule = async (req, { ctx }) => {
  const agencyStub = await getAgencyStub(req.params.agencyId, ctx);
  return agencyStub.fetch(
    new Request(createDoUrl(req, `/schedules/${req.params.scheduleId}/pause`), { method: "POST" })
  );
};
var resumeSchedule = async (req, { ctx }) => {
  const agencyStub = await getAgencyStub(req.params.agencyId, ctx);
  return agencyStub.fetch(
    new Request(createDoUrl(req, `/schedules/${req.params.scheduleId}/resume`), { method: "POST" })
  );
};
var triggerSchedule = async (req, { ctx }) => {
  const agencyStub = await getAgencyStub(req.params.agencyId, ctx);
  return agencyStub.fetch(
    new Request(createDoUrl(req, `/schedules/${req.params.scheduleId}/trigger`), { method: "POST" })
  );
};
var getScheduleRuns = async (req, { ctx }) => {
  const agencyStub = await getAgencyStub(req.params.agencyId, ctx);
  return agencyStub.fetch(new Request(createDoUrl(req, `/schedules/${req.params.scheduleId}/runs`)));
};
var getVars = async (req, { ctx, env }) => {
  const notFound = await requireAgency(req.params.agencyId, env);
  if (notFound) return notFound;
  const agencyStub = await getAgencyStub(req.params.agencyId, ctx);
  return agencyStub.fetch(new Request(createDoUrl(req, "/vars")));
};
var setVars = async (req, { ctx, env }) => {
  const notFound = await requireAgency(req.params.agencyId, env);
  if (notFound) return notFound;
  const agencyStub = await getAgencyStub(req.params.agencyId, ctx);
  return agencyStub.fetch(
    new Request(createDoUrl(req, "/vars"), {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: req.body
    })
  );
};
var getVar = async (req, { ctx, env }) => {
  const notFound = await requireAgency(req.params.agencyId, env);
  if (notFound) return notFound;
  const agencyStub = await getAgencyStub(req.params.agencyId, ctx);
  return agencyStub.fetch(new Request(createDoUrl(req, `/vars/${req.params.varKey}`)));
};
var setVar = async (req, { ctx, env }) => {
  const notFound = await requireAgency(req.params.agencyId, env);
  if (notFound) return notFound;
  const agencyStub = await getAgencyStub(req.params.agencyId, ctx);
  return agencyStub.fetch(
    new Request(createDoUrl(req, `/vars/${req.params.varKey}`), {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: req.body
    })
  );
};
var deleteVar = async (req, { ctx }) => {
  const agencyStub = await getAgencyStub(req.params.agencyId, ctx);
  return agencyStub.fetch(
    new Request(createDoUrl(req, `/vars/${req.params.varKey}`), { method: "DELETE" })
  );
};
var listMcpServers = async (req, { ctx }) => {
  const agencyStub = await getAgencyStub(req.params.agencyId, ctx);
  return agencyStub.fetch(new Request(createDoUrl(req, "/mcp")));
};
var addMcpServer = async (req, { ctx }) => {
  const agencyStub = await getAgencyStub(req.params.agencyId, ctx);
  return agencyStub.fetch(
    new Request(createDoUrl(req, "/mcp"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: req.body
    })
  );
};
var removeMcpServer = async (req, { ctx }) => {
  const agencyStub = await getAgencyStub(req.params.agencyId, ctx);
  return agencyStub.fetch(
    new Request(createDoUrl(req, `/mcp/${req.params.serverId}`), { method: "DELETE" })
  );
};
var retryMcpServer = async (req, { ctx }) => {
  const agencyStub = await getAgencyStub(req.params.agencyId, ctx);
  return agencyStub.fetch(
    new Request(createDoUrl(req, `/mcp/${req.params.serverId}/retry`), { method: "POST" })
  );
};
var listMcpTools = async (req, { ctx }) => {
  const agencyStub = await getAgencyStub(req.params.agencyId, ctx);
  return agencyStub.fetch(new Request(createDoUrl(req, "/mcp/tools")));
};
var callMcpTool = async (req, { ctx }) => {
  const agencyStub = await getAgencyStub(req.params.agencyId, ctx);
  return agencyStub.fetch(
    new Request(createDoUrl(req, "/mcp/call"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: req.body
    })
  );
};
var handleFilesystem = async (req, { ctx }) => {
  const agencyStub = await getAgencyStub(req.params.agencyId, ctx);
  const fsPath = req.params.path || "";
  return agencyStub.fetch(
    new Request(createDoUrl(req, `/fs/${fsPath}`), {
      method: req.method,
      headers: req.headers,
      body: req.body
    })
  );
};
var getMetrics = async (req, { ctx }) => {
  const agencyStub = await getAgencyStub(req.params.agencyId, ctx);
  return agencyStub.fetch(new Request(createDoUrl(req, "/metrics")));
};
var getPresence = async (req, { ctx, env }) => {
  const notFound = await requireAgency(req.params.agencyId, env);
  if (notFound) return notFound;
  const agencyStub = await getAgencyStub(req.params.agencyId, ctx);
  const doUrl = new URL(req.url);
  return agencyStub.fetch(
    new Request(`http://do/presence${doUrl.search}`)
  );
};
var handleAgencyWebSocket = async (req, { ctx }) => {
  const agencyStub = await getAgencyStub(req.params.agencyId, ctx);
  return agencyStub.fetch(req);
};
var handleMcpOAuthCallback = async (req, { ctx }) => {
  const agencyStub = await getAgencyStub(req.params.agencyId, ctx);
  return agencyStub.fetch(req);
};
var handleAgentRequest = async (req, { ctx }) => {
  const hubAgentStub = await getAgentByName(ctx.exports.HubAgent, req.params.agentId);
  const agentPath = req.params.path || "";
  if (req.headers.get("Upgrade")?.toLowerCase() === "websocket") {
    try {
      const agencyStub = await getAgencyStub(req.params.agencyId, ctx);
      await agencyStub.fetch(new Request("http://do/internal/register-agent", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          agentId: req.params.agentId,
          agentType: "co2-assistant"
        })
      }));
    } catch {
    }
    return hubAgentStub.fetch(req);
  }
  const doUrl = new URL(req.url);
  doUrl.pathname = "/" + agentPath;
  let doReq;
  if (agentPath === "invoke" && req.method === "POST") {
    const body = await req.json();
    body.threadId = req.params.agentId;
    doReq = new Request(doUrl, {
      method: req.method,
      headers: req.headers,
      body: JSON.stringify(body)
    });
  } else {
    doReq = new Request(doUrl, req);
  }
  return hubAgentStub.fetch(doReq);
};
var ADMIN_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Agent Hub Admin</title>
<script src="https://www.gstatic.com/firebasejs/11.6.0/firebase-app-compat.js"></script>
<script src="https://www.gstatic.com/firebasejs/11.6.0/firebase-auth-compat.js"></script>
<style>
  :root {
    --bg: #0d1117; --bg2: #161b22; --bg3: #21262d; --border: #30363d;
    --text: #e6edf3; --text2: #8b949e; --accent: #58a6ff; --green: #3fb950;
    --red: #f85149; --yellow: #d29922; --font: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: var(--font); background: var(--bg); color: var(--text); font-size: 14px; }
  .app { display: flex; height: 100vh; }
  .sidebar { width: 260px; background: var(--bg2); border-right: 1px solid var(--border); display: flex; flex-direction: column; flex-shrink: 0; }
  .sidebar h1 { font-size: 16px; padding: 16px; border-bottom: 1px solid var(--border); }
  .sidebar h1 span { color: var(--text2); font-weight: normal; font-size: 12px; }
  .sidebar-section { padding: 12px 16px; border-bottom: 1px solid var(--border); }
  .sidebar-section label { display: block; font-size: 11px; text-transform: uppercase; color: var(--text2); margin-bottom: 6px; letter-spacing: 0.5px; }
  .sidebar-section select, .sidebar-section input { width: 100%; padding: 6px 8px; background: var(--bg3); border: 1px solid var(--border); color: var(--text); border-radius: 4px; font-size: 13px; }
  .nav { flex: 1; overflow-y: auto; padding: 8px 0; }
  .nav-item { display: block; width: 100%; padding: 8px 16px; background: none; border: none; color: var(--text2); text-align: left; cursor: pointer; font-size: 13px; font-family: var(--font); }
  .nav-item:hover { background: var(--bg3); color: var(--text); }
  .nav-item.active { background: var(--bg3); color: var(--accent); border-left: 2px solid var(--accent); }
  .main { flex: 1; overflow-y: auto; padding: 24px; }
  .panel { background: var(--bg2); border: 1px solid var(--border); border-radius: 6px; margin-bottom: 16px; }
  .panel-header { padding: 12px 16px; border-bottom: 1px solid var(--border); display: flex; justify-content: space-between; align-items: center; }
  .panel-header h2 { font-size: 14px; font-weight: 600; }
  .panel-body { padding: 16px; }
  .panel-body.no-pad { padding: 0; }
  table { width: 100%; border-collapse: collapse; }
  th, td { padding: 8px 12px; text-align: left; border-bottom: 1px solid var(--border); font-size: 13px; }
  th { color: var(--text2); font-weight: 500; font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px; background: var(--bg); }
  td { vertical-align: top; }
  .mono { font-family: 'SF Mono', 'Fira Code', monospace; font-size: 12px; }
  .badge { display: inline-block; padding: 2px 8px; border-radius: 10px; font-size: 11px; font-weight: 500; }
  .badge-green { background: rgba(63,185,80,0.15); color: var(--green); }
  .badge-red { background: rgba(248,81,73,0.15); color: var(--red); }
  .badge-yellow { background: rgba(210,153,34,0.15); color: var(--yellow); }
  .badge-blue { background: rgba(88,166,255,0.15); color: var(--accent); }
  .btn { padding: 6px 12px; border-radius: 4px; border: 1px solid var(--border); background: var(--bg3); color: var(--text); cursor: pointer; font-size: 12px; font-family: var(--font); }
  .btn:hover { background: var(--border); }
  .btn-primary { background: rgba(88,166,255,0.15); border-color: var(--accent); color: var(--accent); }
  .btn-danger { background: rgba(248,81,73,0.1); border-color: var(--red); color: var(--red); }
  .btn-sm { padding: 3px 8px; font-size: 11px; }
  .empty { color: var(--text2); font-style: italic; padding: 24px; text-align: center; }
  .status { display: flex; align-items: center; gap: 8px; padding: 12px 16px; font-size: 12px; color: var(--text2); border-top: 1px solid var(--border); }
  .dot { width: 8px; height: 8px; border-radius: 50%; }
  .dot-green { background: var(--green); }
  .dot-red { background: var(--red); }
  .dot-yellow { background: var(--yellow); }
  .form-row { display: flex; gap: 8px; margin-bottom: 8px; }
  .form-row input, .form-row textarea { flex: 1; padding: 6px 8px; background: var(--bg); border: 1px solid var(--border); color: var(--text); border-radius: 4px; font-family: var(--font); font-size: 13px; }
  .form-row textarea { min-height: 60px; resize: vertical; }
  .json-view { background: var(--bg); border: 1px solid var(--border); border-radius: 4px; padding: 12px; overflow-x: auto; white-space: pre-wrap; word-break: break-all; font-family: 'SF Mono', monospace; font-size: 12px; color: var(--text2); max-height: 300px; overflow-y: auto; }
  .tool-call { border: 1px solid var(--border); border-radius: 4px; margin-bottom: 8px; overflow: hidden; }
  .tool-call-header { padding: 8px 12px; background: var(--bg); display: flex; justify-content: space-between; align-items: center; cursor: pointer; }
  .tool-call-header:hover { background: var(--bg3); }
  .tool-call-body { padding: 12px; border-top: 1px solid var(--border); display: none; }
  .tool-call.expanded .tool-call-body { display: block; }
  .message { padding: 12px; border-bottom: 1px solid var(--border); }
  .message:last-child { border-bottom: none; }
  .message-role { font-size: 11px; text-transform: uppercase; color: var(--text2); margin-bottom: 4px; letter-spacing: 0.5px; }
  .message-role.user { color: var(--accent); }
  .message-role.assistant { color: var(--green); }
  .message-role.system { color: var(--yellow); }
  .message-content { font-size: 13px; line-height: 1.5; white-space: pre-wrap; word-break: break-word; }
  .tabs { display: flex; border-bottom: 1px solid var(--border); }
  .tab { padding: 8px 16px; background: none; border: none; color: var(--text2); cursor: pointer; font-size: 13px; font-family: var(--font); border-bottom: 2px solid transparent; }
  .tab:hover { color: var(--text); }
  .tab.active { color: var(--accent); border-bottom-color: var(--accent); }
  .spinner { display: inline-block; width: 14px; height: 14px; border: 2px solid var(--border); border-top-color: var(--accent); border-radius: 50%; animation: spin 0.8s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }
  .toast { position: fixed; bottom: 20px; right: 20px; padding: 10px 16px; border-radius: 6px; font-size: 13px; z-index: 100; animation: fadeIn 0.2s; }
  .toast-success { background: rgba(63,185,80,0.9); color: #fff; }
  .toast-error { background: rgba(248,81,73,0.9); color: #fff; }
  @keyframes fadeIn { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: translateY(0); } }
  .truncate { max-width: 300px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .config-field { margin-bottom: 16px; }
  .config-field label { display: block; font-size: 12px; color: var(--text2); margin-bottom: 4px; }
  .config-field textarea { width: 100%; min-height: 80px; padding: 8px; background: var(--bg); border: 1px solid var(--border); color: var(--text); border-radius: 4px; font-family: 'SF Mono', monospace; font-size: 12px; resize: vertical; }
  .config-field .hint { font-size: 11px; color: var(--text2); margin-top: 4px; }
</style>
</head>
<body>
<div class="app">
  <div class="sidebar">
    <h1>Agent Hub <span>Admin</span></h1>
    <div class="sidebar-section">
      <label>Agency</label>
      <select id="agencySelect" onchange="onAgencyChange()"><option value="">Loading...</option></select>
    </div>
    <div class="sidebar-section">
      <label>Agent</label>
      <select id="agentSelect" onchange="onAgentChange()"><option value="">Select agency first</option></select>
    </div>
    <div class="nav">
      <button class="nav-item active" data-view="memories" onclick="switchView('memories')">Memories</button>
      <button class="nav-item" data-view="journal" onclick="switchView('journal')">Mutation Journal</button>
      <button class="nav-item" data-view="pins" onclick="switchView('pins')">Context Pins</button>
      <button class="nav-item" data-view="workspace" onclick="switchView('workspace')">Workspace Config</button>
      <button class="nav-item" data-view="inspector" onclick="switchView('inspector')">Tool Inspector</button>
      <button class="nav-item" data-view="usage" onclick="switchView('usage')">Usage & Limits</button>
      <button class="nav-item" data-view="replay" onclick="switchView('replay')">Replay</button>
      <button class="nav-item" data-view="state" onclick="switchView('state')">Agent State</button>
    </div>
    <div class="status" id="statusBar">
      <div class="dot dot-yellow"></div>
      <span>Not signed in</span>
    </div>
    <div style="padding:8px 16px;border-top:1px solid var(--border)">
      <button class="btn btn-sm" onclick="doSignOut()" style="width:100%">Sign Out</button>
    </div>
  </div>
  <div class="main" id="mainContent">
    <div class="empty">Select an agency and agent to begin.</div>
  </div>
</div>

<script>
// --- Firebase config (detected from URL: dev vs prod) ---
const FIREBASE_CONFIGS = {
  dev: {
    apiKey: 'AIzaSyBbta_ee3DWNg2Vt81zVJKrmAsOnZTdCt0',
    authDomain: 'co2-target-asset-tracking-dev.firebaseapp.com',
    projectId: 'co2-target-asset-tracking-dev',
  },
  prod: {
    apiKey: 'AIzaSyDrGUku6S-PkwZ39_4q00-HnmrsEelwSW8',
    authDomain: 'co2-target-asset-tracking.firebaseapp.com',
    projectId: 'co2-target-asset-tracking',
  },
};
const isDev = location.hostname.includes('dev.');
const fbConfig = isDev ? FIREBASE_CONFIGS.dev : FIREBASE_CONFIGS.prod;
firebase.initializeApp(fbConfig);
const auth = firebase.auth();

const BASE = location.origin;
let idToken = '';
let currentUser = null;
let currentAgency = '';
let currentAgent = '';
let currentView = 'memories';

// --- API helpers ---
async function api(method, path, body) {
  // Refresh token if needed
  if (currentUser) {
    idToken = await currentUser.getIdToken();
  }
  const headers = { 'Content-Type': 'application/json' };
  if (idToken) headers['Authorization'] = 'Bearer ' + idToken;
  // Fallback: also send as X-SECRET for backwards compat with key-based auth
  const keyParam = new URLSearchParams(location.search).get('key');
  if (keyParam) headers['X-SECRET'] = keyParam;
  const opts = { method, headers };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(BASE + path, opts);
  if (!res.ok) throw new Error(res.status + ': ' + (await res.text()));
  return res.json();
}

async function action(type, payload = {}) {
  return api('POST', '/agency/' + currentAgency + '/agent/' + currentAgent + '/action', { type, ...payload });
}

function toast(msg, type = 'success') {
  const el = document.createElement('div');
  el.className = 'toast toast-' + type;
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 3000);
}

function setStatus(color, text) {
  document.getElementById('statusBar').innerHTML = '<div class="dot dot-' + color + '"></div><span>' + text + '</span>';
}

// --- Auth ---
function showSignIn() {
  document.getElementById('agencySelect').innerHTML = '<option value="">Sign in first</option>';
  document.getElementById('mainContent').innerHTML = '<div class="panel" style="max-width:400px;margin:80px auto">' +
    '<div class="panel-header"><h2>Sign In</h2></div><div class="panel-body">' +
    '<p style="color:var(--text2);margin-bottom:12px">Sign in with your CO2 account.</p>' +
    '<div class="form-row"><input id="emailInput" type="email" placeholder="Email" autofocus></div>' +
    '<div class="form-row"><input id="passInput" type="password" placeholder="Password"></div>' +
    '<div id="authError" style="color:var(--red);font-size:12px;margin-bottom:8px;display:none"></div>' +
    '<div class="form-row"><button class="btn btn-primary" onclick="doSignIn()" id="signInBtn">Sign In</button></div>' +
    '</div></div>';
  document.getElementById('passInput')?.addEventListener('keydown', function(e) { if (e.key === 'Enter') doSignIn(); });
}

async function doSignIn() {
  var email = document.getElementById('emailInput')?.value?.trim();
  var pass = document.getElementById('passInput')?.value;
  if (!email || !pass) return toast('Email and password required', 'error');
  var btn = document.getElementById('signInBtn');
  if (btn) { btn.disabled = true; btn.textContent = 'Signing in...'; }
  var errEl = document.getElementById('authError');
  if (errEl) errEl.style.display = 'none';
  try {
    await auth.signInWithEmailAndPassword(email, pass);
    // onAuthStateChanged will handle the rest
  } catch (e) {
    if (errEl) { errEl.textContent = e.message.replace('Firebase: ', ''); errEl.style.display = 'block'; }
    if (btn) { btn.disabled = false; btn.textContent = 'Sign In'; }
  }
}

function doSignOut() {
  auth.signOut();
}

// Firebase auth state listener
auth.onAuthStateChanged(async function(user) {
  if (user) {
    currentUser = user;
    idToken = await user.getIdToken();
    setStatus('green', user.email);
    init();
  } else {
    currentUser = null;
    idToken = '';
    setStatus('yellow', 'Not signed in');
    // Check for legacy ?key= param
    var keyParam = new URLSearchParams(location.search).get('key');
    if (keyParam) {
      init(); // legacy key-based auth
    } else {
      showSignIn();
    }
  }
});

async function init() {
  try {
    const agencies = await api('GET', '/agencies');
    const sel = document.getElementById('agencySelect');
    sel.innerHTML = '<option value="">Select agency...</option>';
    (agencies || []).forEach(a => {
      const opt = document.createElement('option');
      opt.value = a.id || a.name || a;
      opt.textContent = a.name || a.id || a;
      sel.appendChild(opt);
    });
    setStatus('green', currentUser ? currentUser.email : 'Connected');
    document.getElementById('mainContent').innerHTML = '<div class="empty">Select an agency and agent to begin.</div>';
  } catch (e) {
    if (e.message.includes('401') || e.message.includes('403')) {
      toast('Access denied', 'error');
      if (currentUser) { auth.signOut(); }
      else { showSignIn(); }
    } else {
      setStatus('red', 'Error: ' + e.message);
    }
  }
}

async function onAgencyChange() {
  currentAgency = document.getElementById('agencySelect').value;
  currentAgent = '';
  if (!currentAgency) return;
  try {
    const agents = await api('GET', '/agency/' + currentAgency + '/agents');
    const sel = document.getElementById('agentSelect');
    sel.innerHTML = '<option value="">Select agent...</option>';
    (agents || []).forEach(a => {
      const opt = document.createElement('option');
      opt.value = a.id || a.name || a;
      opt.textContent = (a.name || a.id || a) + (a.agentType ? ' (' + a.agentType + ')' : '');
      sel.appendChild(opt);
    });
  } catch (e) {
    toast('Failed to load agents: ' + e.message, 'error');
  }
}

async function onAgentChange() {
  currentAgent = document.getElementById('agentSelect').value;
  if (!currentAgent) return;
  setStatus('green', 'Agent: ' + currentAgent.slice(0, 8) + '...');
  loadView();
}

// --- Views ---
function switchView(view) {
  currentView = view;
  document.querySelectorAll('.nav-item').forEach(el => {
    el.classList.toggle('active', el.dataset.view === view);
  });
  loadView();
}

async function loadView() {
  if (!currentAgency || !currentAgent) {
    document.getElementById('mainContent').innerHTML = '<div class="empty">Select an agency and agent to begin.</div>';
    return;
  }
  const main = document.getElementById('mainContent');
  main.innerHTML = '<div class="empty"><div class="spinner"></div> Loading...</div>';
  try {
    switch (currentView) {
      case 'memories': await loadMemories(); break;
      case 'journal': await loadJournal(); break;
      case 'pins': await loadPins(); break;
      case 'workspace': await loadWorkspace(); break;
      case 'inspector': await loadInspector(); break;
      case 'usage': await loadUsage(); break;
      case 'replay': await loadReplay(); break;
      case 'state': await loadState(); break;
    }
  } catch (e) {
    main.innerHTML = '<div class="panel"><div class="panel-body"><div class="empty">Error: ' + esc(e.message) + '</div></div></div>';
  }
}

function esc(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }

// --- Memories ---
async function loadMemories() {
  const data = await action('browseMemories');
  const main = document.getElementById('mainContent');
  let html = '<div class="panel"><div class="panel-header"><h2>Memories (' + data.count + ')</h2><button class="btn btn-primary btn-sm" onclick="showAddMemory()">+ Add</button></div>';
  html += '<div class="panel-body no-pad">';
  if (data.count === 0) {
    html += '<div class="empty">No memories stored for this agent.</div>';
  } else {
    html += '<table><tr><th>Key</th><th>Value</th><th>Updated</th><th></th></tr>';
    data.memories.forEach(m => {
      html += '<tr><td class="mono">' + esc(m.key) + '</td><td class="truncate">' + esc(m.value) + '</td>';
      html += '<td class="mono" style="font-size:11px;color:var(--text2)">' + new Date(m.updatedAt).toLocaleString() + '</td>';
      html += '<td><button class="btn btn-sm" onclick="editMemory(\\''+esc(m.key)+'\\',\\''+esc(m.value.replace(/'/g,"\\\\'"))+'\\')" title="Edit">Edit</button> ';
      html += '<button class="btn btn-danger btn-sm" onclick="delMemory(\\''+esc(m.key)+'\\')" title="Delete">Del</button></td></tr>';
    });
    html += '</table>';
  }
  html += '</div></div>';
  html += '<div id="memoryForm"></div>';
  main.innerHTML = html;
}

function showAddMemory(key, value) {
  const el = document.getElementById('memoryForm');
  el.innerHTML = '<div class="panel"><div class="panel-header"><h2>' + (key ? 'Edit' : 'Add') + ' Memory</h2></div><div class="panel-body">' +
    '<div class="form-row"><input id="memKey" placeholder="Key" value="' + esc(key || '') + '" ' + (key ? 'readonly' : '') + '></div>' +
    '<div class="form-row"><textarea id="memVal" placeholder="Value">' + esc(value || '') + '</textarea></div>' +
    '<div class="form-row"><button class="btn btn-primary" onclick="saveMemory()">Save</button> <button class="btn" onclick="document.getElementById(\\'memoryForm\\').innerHTML=\\'\\'">Cancel</button></div>' +
    '</div></div>';
}

function editMemory(key, value) { showAddMemory(key, value); }

async function saveMemory() {
  const key = document.getElementById('memKey').value.trim();
  const value = document.getElementById('memVal').value.trim();
  if (!key || !value) return toast('Key and value required', 'error');
  await action('setMemory', { key, value });
  toast('Memory saved: ' + key);
  loadMemories();
}

async function delMemory(key) {
  if (!confirm('Delete memory "' + key + '"?')) return;
  await action('deleteMemory', { key });
  toast('Memory deleted: ' + key);
  loadMemories();
}

// --- Journal ---
async function loadJournal() {
  const data = await action('browseJournal');
  const main = document.getElementById('mainContent');
  let html = '<div class="panel"><div class="panel-header"><h2>Mutation Journal (' + data.count + ')</h2><button class="btn btn-sm" onclick="loadJournal()">Refresh</button></div>';
  html += '<div class="panel-body no-pad">';
  if (data.count === 0) {
    html += '<div class="empty">No journal entries. Entries are created when the agent performs mutations.</div>';
  } else {
    html += '<table><tr><th>#</th><th>Entry</th></tr>';
    data.entries.forEach((e, i) => {
      html += '<tr><td class="mono" style="color:var(--text2)">' + (i+1) + '</td><td class="mono">' + esc(e) + '</td></tr>';
    });
    html += '</table>';
  }
  html += '</div></div>';
  main.innerHTML = html;
}

// --- Pins ---
async function loadPins() {
  const data = await action('browsePins');
  const main = document.getElementById('mainContent');
  let html = '<div class="panel"><div class="panel-header"><h2>Context Pins (' + data.count + ')</h2><button class="btn btn-sm" onclick="loadPins()">Refresh</button></div>';
  html += '<div class="panel-body no-pad">';
  if (data.count === 0) {
    html += '<div class="empty">No pinned context. Pins are set when the agent encounters important state.</div>';
  } else {
    html += '<table><tr><th>Label</th><th>Content</th></tr>';
    Object.entries(data.pins).forEach(([k, v]) => {
      html += '<tr><td class="mono">' + esc(k) + '</td><td class="mono" style="white-space:pre-wrap">' + esc(v) + '</td></tr>';
    });
    html += '</table>';
  }
  html += '</div></div>';
  main.innerHTML = html;
}

// --- Workspace Config ---
async function loadWorkspace() {
  const data = await action('browseWorkspaceConfig');
  const main = document.getElementById('mainContent');
  let html = '<div class="panel"><div class="panel-header"><h2>Workspace Configuration</h2><button class="btn btn-sm" onclick="loadWorkspace()">Refresh</button></div>';
  html += '<div class="panel-body">';

  // Resolved summary
  html += '<div style="margin-bottom:16px;padding:12px;background:var(--bg);border-radius:4px">';
  html += '<strong style="color:var(--text2);font-size:11px;text-transform:uppercase">Resolved Config</strong><br>';
  const rc = data.resolvedConfig;
  html += '<span class="badge badge-blue">' + (rc.guidance ? 'Guidance set' : 'No guidance') + '</span> ';
  html += '<span class="badge badge-blue">' + (rc.terminology ? Object.keys(rc.terminology).length + ' terms' : '0 terms') + '</span> ';
  html += '<span class="badge ' + (rc.blockedActions?.length ? 'badge-red' : 'badge-blue') + '">' + (rc.blockedActions?.length || 0) + ' blocked</span> ';
  html += '<span class="badge badge-green">' + (rc.virtualToolCount || 0) + ' virtual tools</span> ';
  html += '<span class="badge badge-green">' + (rc.toolHookCount || 0) + ' tool hooks</span>';
  html += '</div>';

  // Editable fields
  const fields = [
    { key: 'WORKSPACE_GUIDANCE', label: 'Guidance', hint: 'Free-text guidance injected into agent system prompt' },
    { key: 'WORKSPACE_TERMINOLOGY', label: 'Terminology (JSON)', hint: '{"term": "definition"} — domain-specific vocabulary' },
    { key: 'WORKSPACE_BLOCKED_ACTIONS', label: 'Blocked Actions', hint: 'Comma-separated action IDs the agent must refuse' },
    { key: 'WORKSPACE_VIRTUAL_TOOLS', label: 'Virtual Tools (JSON)', hint: '[{"name":"...", "description":"...", "response":"..."}]' },
    { key: 'WORKSPACE_TOOL_HOOKS', label: 'Tool Hooks (JSON)', hint: '[{"tool":"...", "before":"...", "after":"..."}]' },
  ];

  fields.forEach(f => {
    const val = data.individualVars[f.key] || '';
    html += '<div class="config-field"><label>' + f.label + '</label>';
    html += '<textarea id="ws_' + f.key + '" rows="3">' + esc(typeof val === 'string' ? val : JSON.stringify(val, null, 2)) + '</textarea>';
    html += '<div class="hint">' + f.hint + '</div></div>';
  });

  html += '<button class="btn btn-primary" onclick="saveWorkspace()">Save All</button> ';
  html += '<button class="btn" onclick="loadWorkspace()">Reset</button>';
  html += '</div></div>';

  // Manifest JSON
  if (data.manifest) {
    html += '<div class="panel"><div class="panel-header"><h2>Raw Manifest</h2></div>';
    html += '<div class="panel-body"><div class="json-view">' + esc(JSON.stringify(data.manifest, null, 2)) + '</div></div></div>';
  }

  main.innerHTML = html;
}

async function saveWorkspace() {
  const fields = ['WORKSPACE_GUIDANCE', 'WORKSPACE_TERMINOLOGY', 'WORKSPACE_BLOCKED_ACTIONS', 'WORKSPACE_VIRTUAL_TOOLS', 'WORKSPACE_TOOL_HOOKS'];
  let saved = 0;
  for (const key of fields) {
    const el = document.getElementById('ws_' + key);
    if (!el) continue;
    const val = el.value.trim();
    if (val) {
      await api('PUT', '/agency/' + currentAgency + '/vars/' + key, { value: val });
      saved++;
    } else {
      try { await api('DELETE', '/agency/' + currentAgency + '/vars/' + key); } catch(e) {}
    }
  }
  toast('Saved ' + saved + ' workspace vars');
  loadWorkspace();
}

// --- Tool Inspector ---
async function loadInspector() {
  const state = await api('GET', '/agency/' + currentAgency + '/agent/' + currentAgent + '/state');
  const main = document.getElementById('mainContent');
  const messages = state.messages || [];

  // Extract tool calls from messages
  const toolCalls = [];
  messages.forEach((msg, i) => {
    if (msg.role === 'assistant' && msg.tool_calls) {
      msg.tool_calls.forEach(tc => {
        toolCalls.push({ index: i, ...tc });
      });
    }
    // Also check for tool_use content blocks (Anthropic format)
    if (msg.role === 'assistant' && Array.isArray(msg.content)) {
      msg.content.forEach(block => {
        if (block.type === 'tool_use') {
          toolCalls.push({ index: i, id: block.id, function: { name: block.name, arguments: JSON.stringify(block.input) } });
        }
      });
    }
  });

  // Tool results
  const toolResults = {};
  messages.forEach(msg => {
    if (msg.role === 'tool' && msg.tool_call_id) {
      toolResults[msg.tool_call_id] = msg.content;
    }
  });

  let html = '<div class="panel"><div class="panel-header"><h2>Tool Inspector (' + toolCalls.length + ' calls)</h2>';
  html += '<button class="btn btn-sm" onclick="loadInspector()">Refresh</button></div>';

  if (toolCalls.length === 0) {
    html += '<div class="panel-body"><div class="empty">No tool calls in this conversation.</div></div>';
  } else {
    html += '<div class="panel-body">';
    toolCalls.forEach((tc, i) => {
      const name = tc.function?.name || tc.name || 'unknown';
      const args = tc.function?.arguments || (tc.input ? JSON.stringify(tc.input) : '{}');
      const result = toolResults[tc.id];
      const resultStr = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
      const isTruncated = resultStr && resultStr.length > 500;

      html += '<div class="tool-call" onclick="this.classList.toggle(\\'expanded\\')">';
      html += '<div class="tool-call-header">';
      html += '<span><span class="badge badge-blue">' + esc(name) + '</span> <span class="mono" style="color:var(--text2);font-size:11px">#' + (i+1) + '</span></span>';
      html += '<span style="color:var(--text2);font-size:11px">' + (result !== undefined ? (typeof result === 'string' && result.includes('error') ? '<span class="badge badge-red">error</span>' : '<span class="badge badge-green">ok</span>') : '<span class="badge badge-yellow">pending</span>') + '</span>';
      html += '</div>';
      html += '<div class="tool-call-body">';
      html += '<div style="margin-bottom:8px"><strong style="font-size:11px;color:var(--text2)">ARGUMENTS</strong></div>';
      html += '<div class="json-view">' + esc(formatJson(args)) + '</div>';
      if (result !== undefined) {
        html += '<div style="margin:8px 0"><strong style="font-size:11px;color:var(--text2)">RESULT</strong></div>';
        html += '<div class="json-view">' + esc(isTruncated ? resultStr.slice(0, 500) + '\\n... (' + resultStr.length + ' chars)' : (resultStr || '(empty)')) + '</div>';
      }
      html += '</div></div>';
    });
    html += '</div>';
  }
  html += '</div>';

  // Conversation timeline
  html += '<div class="panel"><div class="panel-header"><h2>Conversation (' + messages.length + ' messages)</h2></div>';
  html += '<div class="panel-body no-pad">';
  messages.forEach(msg => {
    const role = msg.role || 'unknown';
    let content = '';
    if (typeof msg.content === 'string') {
      content = msg.content;
    } else if (Array.isArray(msg.content)) {
      content = msg.content.map(b => b.text || b.type || '').join('\\n');
    }
    if (content.length > 500) content = content.slice(0, 500) + '... (' + (typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content)).length + ' chars)';
    html += '<div class="message"><div class="message-role ' + role + '">' + role + '</div>';
    html += '<div class="message-content">' + esc(content || '(tool call)') + '</div></div>';
  });
  html += '</div></div>';

  main.innerHTML = html;
}

function formatJson(s) {
  try { return JSON.stringify(JSON.parse(s), null, 2); } catch(e) { return s; }
}

// --- Usage & Limits ---
async function loadUsage() {
  let rateData, fallbackData;
  try { rateData = await action('browseUsage'); } catch(e) { rateData = null; }
  try { fallbackData = await action('browseFallbackState'); } catch(e) { fallbackData = null; }
  const main = document.getElementById('mainContent');
  let html = '';

  // Rate limiting
  html += '<div class="panel"><div class="panel-header"><h2>Rate Limiting</h2><button class="btn btn-sm" onclick="loadUsage()">Refresh</button></div>';
  html += '<div class="panel-body">';
  if (!rateData) {
    html += '<div class="empty">Rate limiting plugin not active on this agent.</div>';
  } else {
    const cw = rateData.currentWindow;
    const cc = rateData.currentConversation;
    html += '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:8px;margin-bottom:16px">';
    // Token usage
    const tokenPct = cw.tokensLimit > 0 ? Math.round((cw.tokensUsed / cw.tokensLimit) * 100) : 0;
    const tokenColor = tokenPct > 80 ? 'var(--red)' : tokenPct > 50 ? 'var(--yellow)' : 'var(--green)';
    html += '<div style="padding:12px;background:var(--bg);border-radius:4px"><div style="font-size:11px;color:var(--text2)">Tokens This Hour</div>';
    html += '<div style="font-size:20px;font-weight:600;color:' + tokenColor + '">' + (cw.tokensUsed || 0).toLocaleString() + '</div>';
    html += '<div style="font-size:11px;color:var(--text2)">of ' + (cw.tokensLimit || 0).toLocaleString() + ' (' + tokenPct + '%)</div></div>';
    // Conversations
    const convoPct = cw.conversationsLimit > 0 ? Math.round((cw.conversationsUsed / cw.conversationsLimit) * 100) : 0;
    const convoColor = convoPct > 80 ? 'var(--red)' : convoPct > 50 ? 'var(--yellow)' : 'var(--green)';
    html += '<div style="padding:12px;background:var(--bg);border-radius:4px"><div style="font-size:11px;color:var(--text2)">Conversations This Hour</div>';
    html += '<div style="font-size:20px;font-weight:600;color:' + convoColor + '">' + (cw.conversationsUsed || 0) + '</div>';
    html += '<div style="font-size:11px;color:var(--text2)">of ' + (cw.conversationsLimit || 0) + ' (' + convoPct + '%)</div></div>';
    // Current conversation
    html += '<div style="padding:12px;background:var(--bg);border-radius:4px"><div style="font-size:11px;color:var(--text2)">This Conversation</div>';
    html += '<div style="font-size:20px;font-weight:600">' + (cc.tokensUsed || 0).toLocaleString() + '</div>';
    html += '<div style="font-size:11px;color:var(--text2)">of ' + (cc.tokensLimit || 0).toLocaleString() + ' limit</div></div>';
    html += '<div style="padding:12px;background:var(--bg);border-radius:4px"><div style="font-size:11px;color:var(--text2)">Status</div>';
    html += '<div style="font-size:14px;font-weight:600">' + (rateData.enabled ? '<span class="badge badge-green">Enabled</span>' : '<span class="badge badge-yellow">Disabled</span>') + '</div></div>';
    html += '</div>';
    // 24h history
    if (rateData.history24h && rateData.history24h.length > 0) {
      html += '<table><tr><th>Hour</th><th>Tokens</th><th>Conversations</th></tr>';
      rateData.history24h.forEach(function(h) {
        html += '<tr><td class="mono" style="font-size:11px">' + h.hour + '</td><td>' + (h.tokens || 0).toLocaleString() + '</td><td>' + (h.conversations || 0) + '</td></tr>';
      });
      html += '</table>';
    }
    html += '<div style="margin-top:12px"><button class="btn btn-danger btn-sm" onclick="resetUsage()">Reset Current Window</button></div>';
  }
  html += '</div></div>';

  // Model fallback
  html += '<div class="panel"><div class="panel-header"><h2>Model Fallback</h2></div>';
  html += '<div class="panel-body">';
  if (!fallbackData) {
    html += '<div class="empty">Model fallback plugin not active on this agent.</div>';
  } else {
    const cs = fallbackData.currentState;
    html += '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:8px">';
    html += '<div style="padding:12px;background:var(--bg);border-radius:4px"><div style="font-size:11px;color:var(--text2)">Fallback Status</div>';
    html += '<div style="font-size:14px;font-weight:600">' + (cs.active ? '<span class="badge badge-yellow">Active: ' + esc(cs.reason || '') + '</span>' : '<span class="badge badge-green">Primary Model</span>') + '</div></div>';
    html += '<div style="padding:12px;background:var(--bg);border-radius:4px"><div style="font-size:11px;color:var(--text2)">Fallback Model</div>';
    html += '<div style="font-size:13px;font-weight:600 mono">' + esc(fallbackData.fallbackModel) + '</div></div>';
    html += '<div style="padding:12px;background:var(--bg);border-radius:4px"><div style="font-size:11px;color:var(--text2)">Token Threshold</div>';
    html += '<div style="font-size:20px;font-weight:600">' + (fallbackData.tokenThreshold || 0).toLocaleString() + '</div>';
    html += '<div style="font-size:11px;color:var(--text2)">Current: ' + (cs.totalTokens || 0).toLocaleString() + '</div></div>';
    html += '<div style="padding:12px;background:var(--bg);border-radius:4px"><div style="font-size:11px;color:var(--text2)">Consecutive Errors</div>';
    html += '<div style="font-size:20px;font-weight:600">' + (cs.consecutiveErrors || 0) + '</div></div>';
    html += '</div>';
  }
  html += '</div></div>';

  main.innerHTML = html;
}

async function resetUsage() {
  if (!confirm('Reset usage counters for the current hour?')) return;
  await action('resetUsage');
  toast('Usage counters reset');
  loadUsage();
}

// --- Replay ---
async function loadReplay() {
  let runsData;
  try { runsData = await action('browseRuns'); } catch(e) { runsData = null; }
  const main = document.getElementById('mainContent');
  let html = '';

  html += '<div class="panel"><div class="panel-header"><h2>Conversation Runs</h2>';
  html += '<span><button class="btn btn-primary btn-sm" onclick="saveCurrentRun()">Save Current</button> ';
  html += '<button class="btn btn-sm" onclick="loadReplay()">Refresh</button></span></div>';
  html += '<div class="panel-body no-pad">';

  if (!runsData || !runsData.runs || runsData.runs.length === 0) {
    html += '<div class="empty">No saved runs. Enable auto-save with HISTORY_ENABLED=true, or click "Save Current" to snapshot the active conversation.</div>';
  } else {
    html += '<table><tr><th>ID</th><th>Name</th><th>Messages</th><th>Tool Calls</th><th>Created</th><th></th></tr>';
    runsData.runs.forEach(function(r) {
      html += '<tr><td class="mono">' + r.id + '</td>';
      html += '<td>' + esc(r.name) + '</td>';
      html += '<td>' + r.messageCount + '</td>';
      html += '<td>' + r.toolCallCount + '</td>';
      html += '<td class="mono" style="font-size:11px;color:var(--text2)">' + new Date(r.createdAt).toLocaleString() + '</td>';
      html += '<td><button class="btn btn-sm" onclick="viewRun(' + r.id + ')">View</button> ';
      html += '<button class="btn btn-danger btn-sm" onclick="deleteRun(' + r.id + ')">Del</button></td></tr>';
    });
    html += '</table>';
  }
  html += '</div></div>';
  html += '<div id="replayDetail"></div>';
  main.innerHTML = html;
}

async function saveCurrentRun() {
  var name = prompt('Run name (leave empty for auto):');
  var payload = name ? { name: name } : {};
  try {
    var result = await action('saveRun', payload);
    if (result.error) { toast(result.error, 'error'); return; }
    toast('Saved: ' + (result.saved || 'ok'));
    loadReplay();
  } catch(e) { toast('Failed: ' + e.message, 'error'); }
}

async function deleteRun(id) {
  if (!confirm('Delete run #' + id + '?')) return;
  await action('deleteRun', { id: id });
  toast('Deleted run #' + id);
  loadReplay();
}

async function viewRun(id) {
  var data = await action('loadRun', { id: id });
  if (data.error) { toast(data.error, 'error'); return; }
  var el = document.getElementById('replayDetail');
  var html = '<div class="panel"><div class="panel-header"><h2>Run: ' + esc(data.name) + '</h2>';
  html += '<span class="mono" style="font-size:11px;color:var(--text2)">' + data.messageCount + ' messages, ' + data.toolCallCount + ' tool calls, ' + new Date(data.createdAt).toLocaleString() + '</span></div>';

  // Tool calls timeline
  if (data.toolCalls && data.toolCalls.length > 0) {
    html += '<div class="panel-body"><strong style="font-size:11px;color:var(--text2);text-transform:uppercase">Tool Calls</strong>';
    data.toolCalls.forEach(function(tc, i) {
      html += '<div class="tool-call" onclick="this.classList.toggle(\'expanded\')">';
      html += '<div class="tool-call-header"><span><span class="badge badge-blue">' + esc(tc.name) + '</span> <span class="mono" style="color:var(--text2);font-size:11px">#' + (i+1) + '</span></span></div>';
      html += '<div class="tool-call-body"><div class="json-view">' + esc(formatJson(tc.args || '{}')) + '</div></div>';
      html += '</div>';
    });
    html += '</div>';
  }

  // Messages
  html += '<div class="panel-body no-pad">';
  html += '<div style="padding:8px 12px;border-bottom:1px solid var(--border)"><strong style="font-size:11px;color:var(--text2);text-transform:uppercase">Conversation</strong></div>';
  (data.messages || []).forEach(function(msg) {
    var role = msg.role || 'unknown';
    var content = '';
    if (typeof msg.content === 'string') { content = msg.content; }
    else if (Array.isArray(msg.content)) { content = msg.content.map(function(b) { return b.text || b.type || ''; }).join('\\n'); }
    if (content.length > 500) content = content.slice(0, 500) + '...';
    html += '<div class="message"><div class="message-role ' + role + '">' + role + '</div>';
    html += '<div class="message-content">' + esc(content || '(tool call)') + '</div></div>';
  });
  html += '</div></div>';
  el.innerHTML = html;
}

// --- Agent State ---
async function loadState() {
  const state = await api('GET', '/agency/' + currentAgency + '/agent/' + currentAgent + '/state');
  const main = document.getElementById('mainContent');
  let html = '<div class="panel"><div class="panel-header"><h2>Agent State</h2><button class="btn btn-sm" onclick="loadState()">Refresh</button></div>';
  html += '<div class="panel-body">';

  // Summary
  html += '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:8px;margin-bottom:16px">';
  html += '<div style="padding:12px;background:var(--bg);border-radius:4px"><div style="font-size:11px;color:var(--text2)">Messages</div><div style="font-size:20px;font-weight:600">' + (state.messages?.length || 0) + '</div></div>';
  html += '<div style="padding:12px;background:var(--bg);border-radius:4px"><div style="font-size:11px;color:var(--text2)">Agent Type</div><div style="font-size:14px;font-weight:600">' + esc(state.agentType || state.info?.agentType || '-') + '</div></div>';
  html += '<div style="padding:12px;background:var(--bg);border-radius:4px"><div style="font-size:11px;color:var(--text2)">Run State</div><div style="font-size:14px;font-weight:600">' + esc(state.runState || '-') + '</div></div>';
  html += '</div>';

  // Raw state
  html += '<div class="json-view" style="max-height:500px">' + esc(JSON.stringify(state, null, 2)) + '</div>';
  html += '</div></div>';
  main.innerHTML = html;
}

// Boot
init();
</script>
</body>
</html>`;

// --- Firebase ID token verification ---
var FIREBASE_PROJECTS = ['co2-target-asset-tracking', 'co2-target-asset-tracking-dev'];
var GOOGLE_CERTS_URL = 'https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com';
var cachedCerts = null;

async function fetchGoogleCerts() {
  if (cachedCerts && Date.now() < cachedCerts.expiresAt) return cachedCerts.keys;
  var res = await fetch(GOOGLE_CERTS_URL);
  if (!res.ok) return {};
  var certs = await res.json();
  var cc = res.headers.get('Cache-Control') || '';
  var maxAge = parseInt((cc.match(/max-age=(\d+)/) || [])[1] || '3600', 10);
  var keys = {};
  for (var [kid, pem] of Object.entries(certs)) {
    try {
      var b64 = pem.replace(/-----[A-Z ]+-----/g, '').replace(/\s/g, '');
      var binary = atob(b64);
      var bytes = new Uint8Array(binary.length);
      for (var i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      keys[kid] = await crypto.subtle.importKey('spki', bytes.buffer, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
    } catch(e) {}
  }
  cachedCerts = { keys, expiresAt: Date.now() + maxAge * 1000 };
  return keys;
}

function decodeJwtPart(part) {
  var padded = part.replace(/-/g, '+').replace(/_/g, '/');
  return JSON.parse(atob(padded));
}

async function verifyFirebaseToken(token) {
  try {
    var parts = token.split('.');
    if (parts.length !== 3) return false;
    var header = decodeJwtPart(parts[0]);
    var payload = decodeJwtPart(parts[1]);
    if (header.alg !== 'RS256') return false;
    var project = FIREBASE_PROJECTS.find(function(p) { return payload.iss === 'https://securetoken.google.com/' + p && payload.aud === p; });
    if (!project) return false;
    var now = Math.floor(Date.now() / 1000);
    if (!payload.exp || payload.exp < now - 300) return false;
    if (!payload.iat || payload.iat > now + 300) return false;
    if (!payload.sub) return false;
    var certs = await fetchGoogleCerts();
    var key = header.kid ? certs[header.kid] : undefined;
    if (!key) return false;
    var sigBytes = Uint8Array.from(atob(parts[2].replace(/-/g, '+').replace(/_/g, '/')), function(c) { return c.charCodeAt(0); });
    var dataBytes = new TextEncoder().encode(parts[0] + '.' + parts[1]);
    return await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, sigBytes, dataBytes);
  } catch(e) { return false; }
}

var createHandler = (opts = {}) => {
  const router = Router();
  router.get("/plugins", getPlugins);
  router.get("/agencies", listAgencies);
  router.post("/agencies", createAgency);
  router.delete("/agency/:agencyId", deleteAgency);
  router.delete("/agency/:agencyId/destroy", deleteAgency);
  router.get("/agency/:agencyId/blueprints", listBlueprints);
  router.post("/agency/:agencyId/blueprints", createBlueprint);
  router.delete("/agency/:agencyId/blueprints/:blueprintName", deleteBlueprint);
  router.get("/agency/:agencyId/agents", listAgents);
  router.get("/agency/:agencyId/agents/tree", getAgentForest);
  router.post("/agency/:agencyId/agents", createAgent);
  router.get("/agency/:agencyId/agents/:agentId/tree", getAgentTree);
  router.delete("/agency/:agencyId/agents/:agentId", deleteAgent);
  router.get("/agency/:agencyId/presence", getPresence);
  router.get("/agency/:agencyId/schedules", listSchedules);
  router.post("/agency/:agencyId/schedules", createSchedule);
  router.get("/agency/:agencyId/schedules/:scheduleId", getSchedule);
  router.patch("/agency/:agencyId/schedules/:scheduleId", updateSchedule);
  router.delete("/agency/:agencyId/schedules/:scheduleId", deleteSchedule);
  router.post("/agency/:agencyId/schedules/:scheduleId/pause", pauseSchedule);
  router.post("/agency/:agencyId/schedules/:scheduleId/resume", resumeSchedule);
  router.post("/agency/:agencyId/schedules/:scheduleId/trigger", triggerSchedule);
  router.get("/agency/:agencyId/schedules/:scheduleId/runs", getScheduleRuns);
  router.get("/agency/:agencyId/vars", getVars);
  router.put("/agency/:agencyId/vars", setVars);
  router.get("/agency/:agencyId/vars/:varKey", getVar);
  router.put("/agency/:agencyId/vars/:varKey", setVar);
  router.delete("/agency/:agencyId/vars/:varKey", deleteVar);
  router.get("/agency/:agencyId/mcp", listMcpServers);
  router.post("/agency/:agencyId/mcp", addMcpServer);
  router.get("/agency/:agencyId/mcp/tools", listMcpTools);
  router.post("/agency/:agencyId/mcp/call", callMcpTool);
  router.delete("/agency/:agencyId/mcp/:serverId", removeMcpServer);
  router.post("/agency/:agencyId/mcp/:serverId/retry", retryMcpServer);
  router.all("/agency/:agencyId/fs/:path+", handleFilesystem);
  router.all("/agency/:agencyId/fs", handleFilesystem);
  router.get("/agency/:agencyId/metrics", getMetrics);
  router.get("/agency/:agencyId/ws", handleAgencyWebSocket);
  router.all("/agency/:agencyId/agent/:agentId/:path+", handleAgentRequest);
  router.all("/agency/:agencyId/agent/:agentId", handleAgentRequest);
  router.get("/oauth/agency/:agencyId/callback", handleMcpOAuthCallback);
  router.get("/admin", () => new Response(ADMIN_HTML, { headers: { "Content-Type": "text/html; charset=utf-8" } }));
  router.all("*", () => new Response("Not found", { status: 404 }));
  return {
    async fetch(req, env, ctx) {
      const url = new URL(req.url);
      if (req.method === "OPTIONS") {
        return new Response(null, { status: 204, headers: CORS_HEADERS });
      }
      const isOAuthCallback = /^\/oauth\/agency\/[^/]+\/callback$/.test(url.pathname) && url.searchParams.has("state");
      const isAdminPage = url.pathname === "/admin";
      const providedSecret = req.headers.get("X-SECRET") || url.searchParams.get("key");
      const secret = process.env.SECRET;
      let authed = !secret || isOAuthCallback || isAdminPage;
      if (!authed && providedSecret && secureCompare(providedSecret, secret)) authed = true;
      if (!authed) {
        const authHeader = req.headers.get("Authorization") || "";
        if (authHeader.startsWith("Bearer ")) {
          if (await verifyFirebaseToken(authHeader.slice(7))) authed = true;
        }
      }
      if (!authed) {
        if (req.headers.get("Upgrade")?.toLowerCase() === "websocket") {
          return withCors(new Response("Unauthorized", { status: 401 }));
        }
        const path = url.pathname;
        if (path.startsWith("/api") || path.startsWith("/agency") || path.startsWith("/agencies") || path.startsWith("/plugins")) {
          return withCors(new Response("Unauthorized", { status: 401 }));
        }
        return new Response(
          "Forbidden: Please provide ?key=YOUR_SECRET or X-SECRET header",
          { status: 403 }
        );
      }
      const response = await router.fetch(req, { env, ctx, opts });
      return withCors(response);
    }
  };
};

// runtime/events.ts
var AgentEventType = /* @__PURE__ */ ((AgentEventType2) => {
  AgentEventType2["AGENT_INVOKED"] = "gen_ai.agent.invoked";
  AgentEventType2["AGENT_STEP"] = "gen_ai.agent.step";
  AgentEventType2["AGENT_PAUSED"] = "gen_ai.agent.paused";
  AgentEventType2["AGENT_RESUMED"] = "gen_ai.agent.resumed";
  AgentEventType2["AGENT_COMPLETED"] = "gen_ai.agent.completed";
  AgentEventType2["AGENT_ERROR"] = "gen_ai.agent.error";
  AgentEventType2["AGENT_CANCELED"] = "gen_ai.agent.canceled";
  AgentEventType2["CHAT_START"] = "gen_ai.chat.start";
  AgentEventType2["CHAT_CHUNK"] = "gen_ai.chat.chunk";
  AgentEventType2["CHAT_FINISH"] = "gen_ai.chat.finish";
  AgentEventType2["TOOL_START"] = "gen_ai.tool.start";
  AgentEventType2["TOOL_FINISH"] = "gen_ai.tool.finish";
  AgentEventType2["TOOL_ERROR"] = "gen_ai.tool.error";
  AgentEventType2["CONTENT_MESSAGE"] = "gen_ai.content.message";
  AgentEventType2["SYSTEM_THREAD_CREATED"] = "gen_ai.system.thread_created";
  AgentEventType2["SYSTEM_REQUEST_ACCEPTED"] = "gen_ai.system.request_accepted";
  AgentEventType2["SYSTEM_CHECKPOINT"] = "gen_ai.system.checkpoint";
  AgentEventType2["PLUGIN_HOOK"] = "gen_ai.plugin.hook";
  return AgentEventType2;
})(AgentEventType || {});
var LegacyEventTypeMap = {
  "thread.created": "gen_ai.system.thread_created" /* SYSTEM_THREAD_CREATED */,
  "request.accepted": "gen_ai.system.request_accepted" /* SYSTEM_REQUEST_ACCEPTED */,
  "run.started": "gen_ai.agent.invoked" /* AGENT_INVOKED */,
  "run.tick": "gen_ai.agent.step" /* AGENT_STEP */,
  "run.paused": "gen_ai.agent.paused" /* AGENT_PAUSED */,
  "run.resumed": "gen_ai.agent.resumed" /* AGENT_RESUMED */,
  "run.canceled": "gen_ai.agent.canceled" /* AGENT_CANCELED */,
  "agent.started": "gen_ai.agent.invoked" /* AGENT_INVOKED */,
  "agent.completed": "gen_ai.agent.completed" /* AGENT_COMPLETED */,
  "agent.error": "gen_ai.agent.error" /* AGENT_ERROR */,
  "checkpoint.saved": "gen_ai.system.checkpoint" /* SYSTEM_CHECKPOINT */,
  "model.started": "gen_ai.chat.start" /* CHAT_START */,
  "model.delta": "gen_ai.chat.chunk" /* CHAT_CHUNK */,
  "model.completed": "gen_ai.chat.finish" /* CHAT_FINISH */,
  "assistant.message": "gen_ai.content.message" /* CONTENT_MESSAGE */,
  "plugin.before_model": "gen_ai.plugin.hook" /* PLUGIN_HOOK */,
  "plugin.after_model": "gen_ai.plugin.hook" /* PLUGIN_HOOK */,
  "tool.started": "gen_ai.tool.start" /* TOOL_START */,
  "tool.output": "gen_ai.tool.finish" /* TOOL_FINISH */,
  "tool.error": "gen_ai.tool.error" /* TOOL_ERROR */
};

// runtime/agent/store.ts
var Store = class {
  constructor(sql) {
    this.sql = sql;
  }
  init() {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        role TEXT NOT NULL,
        content JSON,            -- Strictly stores JSON-serialized content ("text" or [{"type":...}])
        tool_calls JSON,         -- JSON Array of tool calls
        tool_call_id TEXT,       -- ID being responded to
        reasoning_content TEXT,  -- DeepSeek thinking blocks
        created_at INTEGER NOT NULL
      );
      
      CREATE INDEX IF NOT EXISTS idx_messages_role ON messages(role);

      CREATE TABLE IF NOT EXISTS events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        type TEXT NOT NULL,
        data JSON NOT NULL,
        ts TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS context_checkpoints (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        summary TEXT NOT NULL,
        messages_start_seq INTEGER NOT NULL,
        messages_end_seq INTEGER NOT NULL,
        archived_path TEXT,
        created_at INTEGER NOT NULL
      );
    `);
  }
  add(input) {
    const msgs = Array.isArray(input) ? input : [input];
    if (!msgs.length) return;
    const now = Date.now();
    const PARAMS_PER_ROW = 6;
    const MAX_PARAMS = 100;
    const CHUNK_SIZE = Math.floor(MAX_PARAMS / PARAMS_PER_ROW);
    const toJSON = (v) => v === void 0 || v === null ? null : JSON.stringify(v);
    for (let i = 0; i < msgs.length; i += CHUNK_SIZE) {
      const chunk = msgs.slice(i, i + CHUNK_SIZE);
      const placeholders = [];
      const bindings = [];
      for (const m of chunk) {
        placeholders.push(`(?, ?, ?, ?, ?, ?)`);
        bindings.push(m.role);
        bindings.push(toJSON("content" in m ? m.content : void 0));
        bindings.push(toJSON("toolCalls" in m ? m.toolCalls : void 0));
        bindings.push("toolCallId" in m ? m.toolCallId : null);
        bindings.push("reasoning" in m ? m.reasoning : null);
        bindings.push(now);
      }
      const query = `
        INSERT INTO messages (
          role, content, tool_calls, tool_call_id, reasoning_content, created_at
        ) VALUES ${placeholders.join(", ")}
      `;
      this.sql.exec(query, ...bindings);
    }
  }
  getContext(limit = 100) {
    const cursor = this.sql.exec(`
      SELECT * FROM (
        SELECT seq, role, content, tool_calls, tool_call_id, reasoning_content, created_at
        FROM messages 
        ORDER BY seq DESC 
        LIMIT ?
      ) ORDER BY seq ASC
    `, limit);
    return this._mapRows(cursor);
  }
  lastAssistant() {
    const cursor = this.sql.exec(`
      SELECT role, content, tool_calls, tool_call_id, reasoning_content, created_at
      FROM messages 
      WHERE role = 'assistant'
      ORDER BY seq DESC
      LIMIT 1
    `);
    const row = cursor.toArray()[0];
    if (!row) return null;
    return {
      role: "assistant",
      content: row.content ? JSON.parse(row.content) : null,
      toolCalls: row.tool_calls ? JSON.parse(row.tool_calls) : void 0,
      reasoning: row.reasoning_content,
      ts: row.created_at ? new Date(row.created_at).toISOString() : void 0
    };
  }
  addEvent(e) {
    this.sql.exec(
      "INSERT INTO events (type, data, ts) VALUES (?, ?, ?)",
      e.type,
      JSON.stringify(e.data),
      e.ts
    );
    const result = this.sql.exec("SELECT last_insert_rowid() as id").toArray()[0];
    return result ? result.id : 0;
  }
  listEvents() {
    const cursor = this.sql.exec(
      `SELECT seq, type, data, ts FROM events ORDER BY seq ASC`
    );
    const out = [];
    for (const r of cursor) {
      out.push({
        seq: r.seq,
        type: r.type,
        ts: r.ts,
        data: r.data ? JSON.parse(r.data) : {}
      });
    }
    return out;
  }
  _mapRows(cursor) {
    const out = [];
    for (const r of cursor) {
      out.push({
        role: r.role,
        content: r.content ? JSON.parse(r.content) : null,
        toolCalls: r.tool_calls ? JSON.parse(r.tool_calls) : void 0,
        toolCallId: r.tool_call_id || void 0,
        reasoning: r.reasoning_content || void 0,
        ts: r.created_at ? new Date(r.created_at).toISOString() : void 0
      });
    }
    return out;
  }
  getMessageCount() {
    const result = this.sql.exec("SELECT COUNT(*) as count FROM messages").toArray()[0];
    return result ? result.count : 0;
  }
  getMessagesAfter(afterSeq, limit = 1e3) {
    const cursor = this.sql.exec(
      `SELECT seq, role, content, tool_calls, tool_call_id, reasoning_content, created_at
       FROM messages 
       WHERE seq > ?
       ORDER BY seq ASC
       LIMIT ?`,
      afterSeq,
      limit
    );
    return this._mapRows(cursor);
  }
  getMessagesInRange(startSeq, endSeq) {
    const cursor = this.sql.exec(
      `SELECT seq, role, content, tool_calls, tool_call_id, reasoning_content, created_at
       FROM messages 
       WHERE seq >= ? AND seq <= ?
       ORDER BY seq ASC`,
      startSeq,
      endSeq
    );
    return this._mapRows(cursor);
  }
  getLatestCheckpoint() {
    const result = this.sql.exec(
      `SELECT id, summary, messages_start_seq, messages_end_seq, archived_path, created_at
       FROM context_checkpoints
       ORDER BY id DESC
       LIMIT 1`
    ).toArray()[0];
    if (!result) return null;
    return {
      id: result.id,
      summary: result.summary,
      messagesStartSeq: result.messages_start_seq,
      messagesEndSeq: result.messages_end_seq,
      archivedPath: result.archived_path,
      createdAt: result.created_at
    };
  }
  addCheckpoint(summary, messagesStartSeq, messagesEndSeq, archivedPath) {
    this.sql.exec(
      `INSERT INTO context_checkpoints 
       (summary, messages_start_seq, messages_end_seq, archived_path, created_at)
       VALUES (?, ?, ?, ?, ?)`,
      summary,
      messagesStartSeq,
      messagesEndSeq,
      archivedPath ?? null,
      Date.now()
    );
    const result = this.sql.exec("SELECT last_insert_rowid() as id").toArray()[0];
    return result ? result.id : 0;
  }
  deleteMessagesBefore(beforeSeq) {
    this.sql.exec("DELETE FROM messages WHERE seq <= ?", beforeSeq);
    const result = this.sql.exec("SELECT changes() as deleted").toArray()[0];
    return result ? result.deleted : 0;
  }
  getMaxMessageSeq() {
    const result = this.sql.exec("SELECT MAX(seq) as max_seq FROM messages").toArray()[0];
    return result?.max_seq ? result.max_seq : 0;
  }
  getCheckpointCount() {
    const result = this.sql.exec("SELECT COUNT(*) as count FROM context_checkpoints").toArray()[0];
    return result ? result.count : 0;
  }
};

// runtime/persisted.ts
var INTERNAL = /* @__PURE__ */ Symbol("kv-state:internal");
var PERSISTED_REF = "__persistedRef__";
function PersistedObject(kv, opts = {}) {
  const prefix = opts.prefix ?? "";
  const warnOnMutation = opts.warnOnMutation ?? true;
  const defaults = opts.defaults ?? {};
  const cache = /* @__PURE__ */ new Map();
  const keyOf = (prop) => prefix + prop;
  const helpers = {
    [INTERNAL]: { kv, cache, prefix, opts }
  };
  function areValuesEqual(a, b) {
    if (a === b) return true;
    if (typeof a !== typeof b || a === null || b === null) return false;
    if (typeof a !== "object" || typeof b !== "object") return false;
    if (INTERNAL in a && INTERNAL in b) {
      return a[INTERNAL].prefix === b[INTERNAL].prefix;
    }
    if (INTERNAL in a !== INTERNAL in b) return false;
    if (a[PERSISTED_REF] && b[PERSISTED_REF]) {
      return a[PERSISTED_REF] === b[PERSISTED_REF];
    }
    return false;
  }
  function wrapWithMutationWarning(value, propName) {
    if (!warnOnMutation) return value;
    if (value === null || value === void 0) return value;
    if (typeof value !== "object") return value;
    if (INTERNAL in value) return value;
    if (value[PERSISTED_REF]) return value;
    return new Proxy(value, {
      set(target2, prop, val) {
        console.error(
          `\u26A0\uFE0F Persisted Object: Mutation detected on ${propName}.${String(prop)}. This will NOT persist. Use reassignment: obj.${propName} = { ...obj.${propName}, ${String(prop)}: value }`
        );
        return Reflect.set(target2, prop, val);
      },
      deleteProperty(target2, prop) {
        console.error(
          `\u26A0\uFE0F Persisted Object: Delete detected on ${propName}.${String(prop)}. This will NOT persist. Use reassignment to remove properties.`
        );
        return Reflect.deleteProperty(target2, prop);
      }
    });
  }
  const target = helpers;
  const handler = {
    get(_t, prop, _r) {
      if (typeof prop !== "string") {
        return Reflect.get(target, prop);
      }
      if (prop in target) return target[prop];
      const k = keyOf(prop);
      if (cache.has(k)) return cache.get(k);
      const v = kv.get(k);
      if (v && typeof v === "object" && PERSISTED_REF in v) {
        const nested = PersistedObject(kv, {
          prefix: v[PERSISTED_REF],
          warnOnMutation
        });
        cache.set(k, nested);
        return nested;
      }
      const valueToWrap = v !== void 0 ? v : defaults[prop];
      const wrapped = wrapWithMutationWarning(valueToWrap, prop);
      cache.set(k, wrapped);
      return wrapped;
    },
    set(_t, prop, value) {
      if (typeof prop !== "string") return false;
      if (prop in target) {
        throw new Error(`Cannot assign to helper property "${prop}"`);
      }
      const k = keyOf(prop);
      if (cache.has(k)) {
        const cachedValue = cache.get(k);
        if (areValuesEqual(cachedValue, value)) {
          return true;
        }
      }
      if (value === void 0) {
        kv.delete(k);
        cache.delete(k);
      } else {
        if (value && typeof value === "object" && INTERNAL in value) {
          const nestedMeta = value[INTERNAL];
          kv.put(k, { [PERSISTED_REF]: nestedMeta.prefix });
          cache.set(k, value);
        } else {
          kv.put(k, value);
          cache.set(k, wrapWithMutationWarning(value, prop));
        }
      }
      return true;
    },
    deleteProperty(_t, prop) {
      if (typeof prop !== "string") return false;
      if (prop in target) return false;
      const k = keyOf(prop);
      kv.delete(k);
      cache.delete(k);
      return true;
    },
    has(_t, prop) {
      if (typeof prop !== "string") return prop in target;
      if (prop in target) return true;
      const k = keyOf(prop);
      if (cache.has(k)) return true;
      if (kv.get(k) !== void 0) return true;
      if (prop in defaults) return true;
      return false;
    },
    ownKeys() {
      if (typeof kv.list === "function") {
        const listed = kv.list({ prefix });
        const fromKv = Array.isArray(listed) ? listed : Array.from(listed);
        return Array.from(
          /* @__PURE__ */ new Set([
            // kv.list() returns [key, value] tuples, so extract just the key
            ...fromKv.map((entry) => {
              const key = Array.isArray(entry) ? entry[0] : entry;
              return typeof key === "string" ? key.slice(prefix.length) : key;
            }),
            ...Array.from(cache.keys()).filter((k) => k.startsWith(prefix)).map((k) => k.slice(prefix.length))
          ])
        );
      }
      return Array.from(cache.keys()).filter((k) => k.startsWith(prefix)).map((k) => k.slice(prefix.length));
    },
    getOwnPropertyDescriptor(_t, prop) {
      return {
        configurable: true,
        enumerable: true,
        writable: true,
        value: target[prop]
      };
    }
  };
  return new Proxy(target, handler);
}

// runtime/fs.ts
var AgentFileSystem = class {
  constructor(bucket, ctx) {
    this.bucket = bucket;
    this.ctx = ctx;
  }
  get homePrefix() {
    return `${this.ctx.agencyId}/agents/${this.ctx.agentId}/`;
  }
  get sharedPrefix() {
    return `${this.ctx.agencyId}/shared/`;
  }
  get agencyPrefix() {
    return `${this.ctx.agencyId}/`;
  }
  resolvePath(userPath) {
    const p = userPath.trim();
    if (p === "~" || p === "~/") return this.homePrefix;
    if (p.startsWith("~/")) return this.homePrefix + p.slice(2);
    if (p.startsWith("/")) {
      const withoutSlash = p.slice(1);
      if (withoutSlash === "shared" || withoutSlash.startsWith("shared/")) {
        return this.agencyPrefix + withoutSlash;
      }
      if (withoutSlash.startsWith("agents/")) {
        return this.agencyPrefix + withoutSlash;
      }
      return this.homePrefix + withoutSlash;
    }
    return this.homePrefix + p;
  }
  toUserPath(r2Key) {
    if (!r2Key.startsWith(this.agencyPrefix)) return r2Key;
    const agencyRelative = r2Key.slice(this.agencyPrefix.length);
    const homeRel = `agents/${this.ctx.agentId}/`;
    if (agencyRelative.startsWith(homeRel)) {
      const rel = agencyRelative.slice(homeRel.length);
      return rel || ".";
    }
    return "/" + agencyRelative;
  }
  objToEntry(obj) {
    return {
      type: "file",
      path: this.toUserPath(obj.key),
      size: obj.size,
      ts: obj.uploaded
    };
  }
  checkAccess(r2Key, mode) {
    if (!r2Key.startsWith(this.agencyPrefix)) {
      return { allowed: false, reason: "Path outside agency" };
    }
    const rel = r2Key.slice(this.agencyPrefix.length);
    if (rel.startsWith("shared/") || rel === "shared") {
      return { allowed: true };
    }
    const ownHome = `agents/${this.ctx.agentId}/`;
    if (rel.startsWith(ownHome) || rel === `agents/${this.ctx.agentId}`) {
      return { allowed: true };
    }
    if (rel.startsWith("agents/")) {
      if (mode === "read") {
        return { allowed: true };
      }
      return { allowed: false, reason: "Cannot write to another agent's home" };
    }
    return { allowed: false, reason: "Invalid path" };
  }
  async readDir(path = ".") {
    let r2Prefix = this.resolvePath(path);
    if (!r2Prefix.endsWith("/")) r2Prefix += "/";
    const access = this.checkAccess(r2Prefix, "read");
    if (!access.allowed) {
      throw new Error(`Access denied: ${access.reason}`);
    }
    const list = await this.bucket.list({
      prefix: r2Prefix,
      delimiter: "/"
    });
    const entries = [
      ...list.objects.map((obj) => this.objToEntry(obj)),
      ...list.delimitedPrefixes.map((pref) => ({
        type: "dir",
        path: this.toUserPath(pref)
      }))
    ];
    return entries.sort((a, b) => a.path.localeCompare(b.path));
  }
  async delete(paths) {
    const r2Keys = [];
    for (const p of paths) {
      const key = this.resolvePath(p);
      const access = this.checkAccess(key, "write");
      if (!access.allowed) {
        throw new Error(`Cannot delete '${p}': ${access.reason}`);
      }
      r2Keys.push(key);
    }
    await this.bucket.delete(r2Keys);
  }
  async stat(path) {
    const r2Key = this.resolvePath(path);
    const access = this.checkAccess(r2Key, "read");
    if (!access.allowed) {
      throw new Error(`Access denied: ${access.reason}`);
    }
    const obj = await this.bucket.head(r2Key);
    if (!obj) return null;
    return this.objToEntry(obj);
  }
  async writeFile(path, data) {
    const r2Key = this.resolvePath(path);
    const access = this.checkAccess(r2Key, "write");
    if (!access.allowed) {
      throw new Error(`Cannot write '${path}': ${access.reason}`);
    }
    await this.bucket.put(r2Key, data);
  }
  async readFile(path, stream = false) {
    const r2Key = this.resolvePath(path);
    const access = this.checkAccess(r2Key, "read");
    if (!access.allowed) {
      throw new Error(`Cannot read '${path}': ${access.reason}`);
    }
    const obj = await this.bucket.get(r2Key);
    if (!obj || !obj.body) return null;
    return stream ? obj.body : obj.text();
  }
  async editFile(path, oldStr, newStr, replaceAll = false) {
    const current = await this.readFile(path, false);
    if (current === null) {
      return { replaced: 0, content: "" };
    }
    const count = (current.match(new RegExp(escapeRegExp(oldStr), "g")) || []).length;
    if (count === 0) {
      return { replaced: 0, content: current };
    }
    if (!replaceAll && count > 1) {
      return { replaced: -count, content: current };
    }
    const content = replaceAll ? current.split(oldStr).join(newStr) : current.replace(oldStr, newStr);
    await this.writeFile(path, content);
    return { replaced: replaceAll ? count : 1, content };
  }
  async exists(path) {
    const entry = await this.stat(path);
    return entry !== null;
  }
};
function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// runtime/plan.ts
var ModelPlanBuilder = class {
  constructor(agent) {
    this.agent = agent;
    this.sysParts = [];
    this._toolChoice = "auto";
  }
  addSystemPrompt(...parts) {
    for (const p of parts) if (p) this.sysParts.push(p);
  }
  setModel(id) {
    if (id) this._model = id;
  }
  setToolChoice(choice) {
    this._toolChoice = choice ?? "auto";
  }
  setResponseFormat(fmt) {
    this._responseFormat = fmt;
  }
  setTemperature(t) {
    this._temperature = t;
  }
  setMaxTokens(n) {
    this._maxTokens = n;
  }
  setStop(stop) {
    this._stop = stop;
  }
  setMessages(messages) {
    this._messages = messages;
  }
  build() {
    const systemPrompt = [this.agent.blueprint.prompt, ...this.sysParts].filter(Boolean).join("\n\n");
    const toolDefs = Object.values(this.agent.tools).map((tool2) => tool2.meta);
    const messages = this._messages ?? this.agent.messages.filter((m) => m.role !== "system");
    return {
      model: this._model ?? this.agent.model ?? "openai:gpt-4.1",
      systemPrompt,
      messages,
      toolDefs,
      toolChoice: this._toolChoice,
      responseFormat: this._responseFormat,
      temperature: this._temperature,
      maxTokens: this._maxTokens,
      stop: this._stop
    };
  }
};

// runtime/config.ts
var VAR_LLM_API_KEY = "LLM_API_KEY";
var VAR_LLM_API_BASE = "LLM_API_BASE";
var DEFAULT_LLM_API_BASE = "https://api.openai.com/v1";
var VAR_DEFAULT_MODEL = "DEFAULT_MODEL";
var VAR_LLM_RETRY_MAX = "LLM_RETRY_MAX";
var DEFAULT_LLM_RETRY_MAX = 2;
var VAR_LLM_RETRY_BACKOFF_MS = "LLM_RETRY_BACKOFF_MS";
var DEFAULT_LLM_RETRY_BACKOFF_MS = 500;
var VAR_LLM_RETRY_MAX_BACKOFF_MS = "LLM_RETRY_MAX_BACKOFF_MS";
var DEFAULT_LLM_RETRY_MAX_BACKOFF_MS = 8e3;
var VAR_LLM_RETRY_JITTER_RATIO = "LLM_RETRY_JITTER_RATIO";
var DEFAULT_LLM_RETRY_JITTER_RATIO = 0.2;
var VAR_LLM_RETRY_STATUS_CODES = "LLM_RETRY_STATUS_CODES";
var DEFAULT_LLM_RETRY_STATUS_CODES = [429, 500, 502, 503, 504, 520];
var DEFAULT_MAX_ITERATIONS = 200;
var MAX_TOOLS_PER_TICK = 25;
var DEFAULT_CONTEXT_KEEP_RECENT = 20;
var DEFAULT_CONTEXT_SUMMARIZE_AT = 40;
var DEFAULT_CONTEXT_MEMORY_DISK = void 0;
var DEFAULT_CONTEXT_SUMMARY_MODEL = void 0;

// runtime/agent/index.ts
var HubAgent = class extends Agent {
  constructor(ctx, env) {
    super(ctx, env);
    this._tools = {};
    this._fs = null;
    /** WebSocket connection to Agency for event relay during active runs */
    this._agencyWs = null;
    this._agencyWsConnecting = false;
    this.observability = void 0;
    this._pluginsInitialized = false;
    const { kv, sql } = ctx.storage;
    this.store = new Store(sql);
    this.store.init();
    this.info = PersistedObject(kv, { prefix: "_info" });
    this.runState = PersistedObject(kv, {
      prefix: "_runState",
      defaults: {
        status: "registered",
        step: 0
      }
    });
    this.vars = PersistedObject(kv, {
      prefix: "_vars",
      defaults: {
        MAX_ITERATIONS: DEFAULT_MAX_ITERATIONS
      }
    });
  }
  get kv() {
    return this.ctx.storage.kv;
  }
  get sqlite() {
    const sql = this.sql;
    return sql.bind(this);
  }
  get exports() {
    return this.ctx.exports;
  }
  get messages() {
    return this.store.getContext(1e3);
  }
  get model() {
    const model = this.vars.DEFAULT_MODEL || this.blueprint.model;
    if (!model)
      throw new Error(
        "Agent blueprint.model and vars.DEFAULT_MODEL are both missing!"
      );
    return model;
  }
  /** R2-backed filesystem with per-agent home directory and shared space. */
  get fs() {
    if (this._fs) return this._fs;
    const bucket = this.env.FS;
    if (!bucket)
      throw new Error(
        "R2 bucket not configured. Set FS binding in wrangler.jsonc."
      );
    const agencyId = this.info.agencyId;
    const agentId = this.info.threadId;
    if (!agencyId || !agentId)
      throw new Error("Agent identity not set. Call registerThread first.");
    this._fs = new AgentFileSystem(bucket, { agencyId, agentId });
    return this._fs;
  }
  get pluginContext() {
    return {
      agent: this,
      env: this.env,
      registerTool: (tool2) => {
        this._tools[tool2.meta.name] = tool2;
      }
    };
  }
  get isPaused() {
    return this.runState.status === "paused";
  }
  async onRequest(req) {
    const url = new URL(req.url);
    switch (url.pathname) {
      case "/invoke":
        return this.invoke(req);
      case "/action":
        return this.action(req);
      case "/state":
        return this.getState(req);
      case "/events":
        return this.getEvents(req);
      case "/register":
        if (req.method === "POST") return this.registerThread(req);
        return new Response("method not allowed", { status: 405 });
      case "/destroy":
        if (req.method === "DELETE") {
          await this.destroy();
          return new Response(null, { status: 204 });
        }
        return new Response("method not allowed", { status: 405 });
      case "/connections":
        return Response.json({
          connections: [...this.getConnections()].length
        });
      default:
        return new Response("not found", { status: 404 });
    }
  }
  async scheduleStep() {
    const now = /* @__PURE__ */ new Date();
    this.runState.nextAlarmAt = now.getTime();
    await this.schedule(now, "run");
  }
  async ensureScheduled() {
    if (this.runState.status !== "running") return;
    const schedules = this.getSchedules();
    if (!schedules.length) await this.scheduleStep();
  }
  async registerThread(req) {
    try {
      const metadata = await req.json().catch(() => null);
      if (!metadata || !metadata.id) {
        return new Response("invalid metadata", { status: 400 });
      }
      if (!this.info.threadId) {
        this.info.threadId = metadata.id;
      }
      this.info.createdAt = metadata.createdAt;
      this.info.request = metadata.request;
      if (metadata.agentType) {
        this.info.agentType = metadata.agentType;
      }
      if (metadata.vars) {
        Object.assign(this.vars, metadata.vars);
      }
      await this.onRegister(metadata);
      return Response.json({ ok: true });
    } catch (error) {
      const err = error;
      return new Response(err.message, { status: 500 });
    }
  }
  async invoke(req) {
    try {
      const body = await req.json().catch(() => ({}));
      if (body.vars) {
        Object.assign(this.vars, body.vars);
      }
      if (body.messages?.length) this.store.add(body.messages);
      if (body.files && typeof body.files === "object") {
        const fs = this.fs;
        await Promise.all(
          Object.entries(body.files).map(
            ([filename, content]) => fs.writeFile(`~/${filename}`, content)
          )
        );
      }
      const runState = this.runState;
      if (["completed", "canceled", "error", "registered"].includes(
        runState.status
      )) {
        runState.status = "running";
        await this.connectToAgency();
        this.emit("gen_ai.agent.invoked" /* AGENT_INVOKED */, {});
        await this.ensureScheduled();
      }
      const { status } = runState;
      return Response.json({ status }, { status: 202 });
    } catch (error) {
      const err = error;
      return Response.json(
        { error: err.message, stack: err.stack },
        { status: 500 }
      );
    }
  }
  async run() {
    try {
      if (this.runState.status !== "running") return;
      if (!this._pluginsInitialized) {
        for (const p of this.plugins) await p.onInit?.(this.pluginContext);
        this._pluginsInitialized = true;
      }
      const maxIterations = this.vars.MAX_ITERATIONS;
      const iterationLimit = maxIterations === 0 ? Infinity : maxIterations ?? DEFAULT_MAX_ITERATIONS;
      if (this.runState.step >= iterationLimit) {
        this.runState.status = "error";
        this.runState.reason = `Maximum iterations exceeded (${iterationLimit})`;
        this.emit("gen_ai.agent.error" /* AGENT_ERROR */, {
          "error.type": "max_iterations_exceeded",
          "error.message": this.runState.reason
        });
        return;
      }
      this.emit("gen_ai.agent.step" /* AGENT_STEP */, {
        step: this.runState.step
      });
      this.runState.step += 1;
      for (const p of this.plugins) await p.onTick?.(this.pluginContext);
      if (this.isPaused) return;
      const hasPendingTools = (this.info.pendingToolCalls ?? []).length > 0;
      if (!hasPendingTools) {
        const plan = new ModelPlanBuilder(this);
        for (const p of this.plugins)
          await p.beforeModel?.(this.pluginContext, plan);
        if (this.isPaused) return;
        const req = plan.build();
        const res = await this.provider.invoke(req, {});
        for (const p of this.plugins)
          await p.onModelResult?.(this.pluginContext, res);
        this.store.add(res.message);
        let toolCalls = [];
        let reply = "";
        if ("toolCalls" in res.message) toolCalls = res.message.toolCalls;
        if ("content" in res.message) reply = res.message.content;
        if (reply) {
          this.emit("gen_ai.content.message" /* CONTENT_MESSAGE */, {
            "gen_ai.content.text": reply,
            "gen_ai.content.tool_calls": toolCalls.length > 0 ? toolCalls.map((tc) => ({
              id: tc.id,
              name: tc.name,
              arguments: tc.args
            })) : void 0
          });
        }
        if (!toolCalls.length) {
          this.runState.status = "completed";
          for (const plugin of this.plugins) {
            try {
              await plugin.onRunComplete?.(this.pluginContext, {
                final: reply
              });
            } catch (pluginError) {
              console.error(
                `Plugin ${plugin.name} onRunComplete error:`,
                pluginError
              );
            }
          }
          this.emit("gen_ai.agent.completed" /* AGENT_COMPLETED */, { result: reply });
          this.disconnectFromAgency();
          return;
        }
        this.info.pendingToolCalls = toolCalls;
      }
      if (this.isPaused) return;
      await this.executePendingTools(MAX_TOOLS_PER_TICK);
      if (this.isPaused) return;
      await this.scheduleStep();
    } catch (error) {
      this.runState.status = "error";
      this.runState.reason = String(
        error instanceof Error ? error.message : error
      );
      this.emit("gen_ai.agent.error" /* AGENT_ERROR */, {
        "error.type": "runtime_error",
        "error.message": this.runState.reason,
        "error.stack": error instanceof Error ? error.stack : void 0
      });
      this.disconnectFromAgency();
    }
  }
  async action(req) {
    const { type, ...payload } = await req.json();
    if (type === "cancel") {
      if (this.runState.status !== "completed") {
        this.runState.status = "canceled";
        this.runState.reason = "user";
        this.emit("gen_ai.agent.canceled" /* AGENT_CANCELED */, {});
        this.disconnectFromAgency();
      }
      return Response.json({ ok: true });
    }
    for (const plugin of this.plugins) {
      if (plugin.actions?.[type]) {
        const result = await plugin.actions[type](this.pluginContext, payload);
        return Response.json(result);
      }
    }
    return new Response(`unknown action: ${type}`, { status: 400 });
  }
  getState(_req) {
    const { threadId, agencyId, agentType, request, createdAt } = this.info;
    if (!agentType) {
      return Response.json({
        state: {
          messages: [],
          threadId,
          agentType: null,
          model: null,
          tools: [],
          thread: { id: threadId, request, createdAt, agentType: null, agencyId }
        },
        run: this.runState,
        error: "Agent not yet initialized (missing agentType)"
      });
    }
    const { model, messages } = this;
    const tools = Object.values(this.tools).map((tool2) => tool2.meta);
    let state = {
      messages,
      threadId,
      agentType,
      model,
      tools,
      thread: {
        id: threadId,
        request,
        createdAt,
        agentType,
        agencyId
      }
    };
    for (const p of this.plugins) {
      if (p.state) {
        state = { ...state, ...p.state(this.pluginContext) };
      }
    }
    return Response.json({ state, run: this.runState });
  }
  getEvents(_req) {
    return Response.json({ events: this.store.listEvents() });
  }
  async executePendingTools(maxTools) {
    let toolBatch = [];
    const calls = this.info.pendingToolCalls ?? [];
    if (calls.length <= maxTools) {
      toolBatch = calls;
      this.info.pendingToolCalls = [];
    } else {
      toolBatch = calls.slice(0, maxTools);
      this.info.pendingToolCalls = calls.slice(maxTools);
    }
    for (const call of toolBatch)
      await Promise.all(
        this.plugins.map((p) => p.onToolStart?.(this.pluginContext, call))
      );
    const tools = this.tools;
    const toolResults = await Promise.all(
      toolBatch.map(async (call) => {
        this.emit("gen_ai.tool.start" /* TOOL_START */, {
          "gen_ai.tool.name": call.name,
          "gen_ai.tool.call.id": call.id,
          "gen_ai.tool.arguments": call.args
        });
        try {
          if (!tools[call.name]) {
            return { call, error: new Error(`Tool ${call.name} not found`) };
          }
          const out = await tools[call.name].execute(call.args, {
            agent: this,
            env: this.env,
            callId: call.id
          });
          if (out === null) return { call, out };
          this.emit("gen_ai.tool.finish" /* TOOL_FINISH */, {
            "gen_ai.tool.name": call.name,
            "gen_ai.tool.call.id": call.id,
            "gen_ai.tool.response": out
          });
          return { call, out };
        } catch (e) {
          return { call, error: e };
        }
      })
    );
    await Promise.all(
      toolResults.map(async (r) => {
        if ("error" in r && r.error) {
          const { error, call } = r;
          this.emit("gen_ai.tool.error" /* TOOL_ERROR */, {
            "gen_ai.tool.name": call.name,
            "gen_ai.tool.call.id": call.id,
            "error.type": "tool_execution_error",
            "error.message": String(error instanceof Error ? error.message : error)
          });
          await Promise.all(
            this.plugins.map(
              (p) => p.onToolError?.(this.pluginContext, r.call, r.error)
            )
          );
        } else if ("out" in r) {
          await Promise.all(
            this.plugins.map(
              (p) => p.onToolResult?.(this.pluginContext, r.call, r.out)
            )
          );
        }
      })
    );
    const messages = toolResults.filter((r) => r.out !== null || !!r.error).map(({ call, out, error }) => {
      const content = error ? `Error: ${error instanceof Error ? error.message : String(error)}` : typeof out === "string" ? out : JSON.stringify(out ?? "Tool had no output");
      return {
        role: "tool",
        content,
        toolCallId: call.id
      };
    });
    this.store.add(messages);
  }
  emit(type, data) {
    const evt = {
      type,
      data,
      threadId: this.info.threadId || this.ctx.id.toString(),
      ts: (/* @__PURE__ */ new Date()).toISOString()
    };
    const seq = this.store.addEvent(evt);
    const event = { ...evt, seq };
    for (const p of this.plugins) {
      try {
        p.onEvent?.(this.pluginContext, event);
      } catch (e) {
        console.error(`Plugin ${p.name} onEvent error:`, e);
      }
    }
    this.broadcast(JSON.stringify(event));
    this.relayEventToAgency(event);
  }
  /**
   * Connect to the Agency via WebSocket for event relay.
   * Called when a run starts. The Agency stays awake while agents have active runs.
   */
  async connectToAgency() {
    const agencyId = this.info.agencyId;
    if (!agencyId || this._agencyWs || this._agencyWsConnecting) return;
    this._agencyWsConnecting = true;
    try {
      const agencyStub = await getAgentByName(this.exports.Agency, agencyId);
      const resp = await agencyStub.fetch("http://do/internal/agent-ws", {
        headers: {
          "Upgrade": "websocket",
          "X-Agent-Id": this.info.threadId,
          "X-Agent-Type": this.info.agentType
        }
      });
      const ws = resp.webSocket;
      if (!ws) {
        console.error("[Agent\u2192Agency WS] No WebSocket in response");
        this._agencyWsConnecting = false;
        return;
      }
      ws.accept();
      this._agencyWs = ws;
      this._agencyWsConnecting = false;
      ws.addEventListener("close", () => {
        this._agencyWs = null;
      });
      ws.addEventListener("error", () => {
        this._agencyWs = null;
      });
    } catch (e) {
      console.error("[Agent\u2192Agency WS] Failed to connect:", e);
      this._agencyWsConnecting = false;
    }
  }
  /**
   * Disconnect from the Agency WebSocket.
   * Called when a run completes, errors, or is canceled.
   */
  disconnectFromAgency() {
    if (this._agencyWs) {
      try {
        this._agencyWs.close(1e3, "run_ended");
      } catch {
      }
      this._agencyWs = null;
    }
  }
  /**
   * Relay an event to the Agency via WebSocket.
   */
  relayEventToAgency(event) {
    if (!this._agencyWs) return;
    const relayEvent = {
      ...event,
      agentId: this.info.threadId,
      agentType: this.info.agentType
    };
    try {
      this._agencyWs.send(JSON.stringify(relayEvent));
    } catch (e) {
      console.debug("[Agent\u2192Agency WS] Send failed:", e);
    }
  }
};

// ../../../node_modules/cron-schedule/dist/utils.js
function extractDateElements(date) {
  return {
    second: date.getSeconds(),
    minute: date.getMinutes(),
    hour: date.getHours(),
    day: date.getDate(),
    month: date.getMonth(),
    weekday: date.getDay(),
    year: date.getFullYear()
  };
}
function getDaysInMonth(year, month) {
  return new Date(year, month + 1, 0).getDate();
}
function getDaysBetweenWeekdays(weekday1, weekday2) {
  if (weekday1 <= weekday2) {
    return weekday2 - weekday1;
  }
  return 6 - weekday1 + weekday2 + 1;
}

// ../../../node_modules/cron-schedule/dist/cron.js
var Cron = class {
  constructor({ seconds, minutes, hours, days, months, weekdays }) {
    if (!seconds || seconds.size === 0)
      throw new Error("There must be at least one allowed second.");
    if (!minutes || minutes.size === 0)
      throw new Error("There must be at least one allowed minute.");
    if (!hours || hours.size === 0)
      throw new Error("There must be at least one allowed hour.");
    if (!months || months.size === 0)
      throw new Error("There must be at least one allowed month.");
    if ((!weekdays || weekdays.size === 0) && (!days || days.size === 0))
      throw new Error("There must be at least one allowed day or weekday.");
    this.seconds = Array.from(seconds).sort((a, b) => a - b);
    this.minutes = Array.from(minutes).sort((a, b) => a - b);
    this.hours = Array.from(hours).sort((a, b) => a - b);
    this.days = Array.from(days).sort((a, b) => a - b);
    this.months = Array.from(months).sort((a, b) => a - b);
    this.weekdays = Array.from(weekdays).sort((a, b) => a - b);
    const validateData = (name, data, constraint) => {
      if (data.some((x) => typeof x !== "number" || x % 1 !== 0 || x < constraint.min || x > constraint.max)) {
        throw new Error(`${name} must only consist of integers which are within the range of ${constraint.min} and ${constraint.max}`);
      }
    };
    validateData("seconds", this.seconds, { min: 0, max: 59 });
    validateData("minutes", this.minutes, { min: 0, max: 59 });
    validateData("hours", this.hours, { min: 0, max: 23 });
    validateData("days", this.days, { min: 1, max: 31 });
    validateData("months", this.months, { min: 0, max: 11 });
    validateData("weekdays", this.weekdays, { min: 0, max: 6 });
    this.reversed = {
      seconds: this.seconds.map((x) => x).reverse(),
      minutes: this.minutes.map((x) => x).reverse(),
      hours: this.hours.map((x) => x).reverse(),
      days: this.days.map((x) => x).reverse(),
      months: this.months.map((x) => x).reverse(),
      weekdays: this.weekdays.map((x) => x).reverse()
    };
  }
  /**
   * Find the next or previous hour, starting from the given start hour that matches the hour constraint.
   * startHour itself might also be allowed.
   */
  findAllowedHour(dir, startHour) {
    return dir === "next" ? this.hours.find((x) => x >= startHour) : this.reversed.hours.find((x) => x <= startHour);
  }
  /**
   * Find the next or previous minute, starting from the given start minute that matches the minute constraint.
   * startMinute itself might also be allowed.
   */
  findAllowedMinute(dir, startMinute) {
    return dir === "next" ? this.minutes.find((x) => x >= startMinute) : this.reversed.minutes.find((x) => x <= startMinute);
  }
  /**
   * Find the next or previous second, starting from the given start second that matches the second constraint.
   * startSecond itself IS NOT allowed.
   */
  findAllowedSecond(dir, startSecond) {
    return dir === "next" ? this.seconds.find((x) => x > startSecond) : this.reversed.seconds.find((x) => x < startSecond);
  }
  /**
   * Find the next or previous time, starting from the given start time that matches the hour, minute
   * and second constraints. startTime itself might also be allowed.
   */
  findAllowedTime(dir, startTime) {
    let hour = this.findAllowedHour(dir, startTime.hour);
    if (hour !== void 0) {
      if (hour === startTime.hour) {
        let minute = this.findAllowedMinute(dir, startTime.minute);
        if (minute !== void 0) {
          if (minute === startTime.minute) {
            const second = this.findAllowedSecond(dir, startTime.second);
            if (second !== void 0) {
              return { hour, minute, second };
            }
            minute = this.findAllowedMinute(dir, dir === "next" ? startTime.minute + 1 : startTime.minute - 1);
            if (minute !== void 0) {
              return {
                hour,
                minute,
                second: dir === "next" ? this.seconds[0] : this.reversed.seconds[0]
              };
            }
          } else {
            return {
              hour,
              minute,
              second: dir === "next" ? this.seconds[0] : this.reversed.seconds[0]
            };
          }
        }
        hour = this.findAllowedHour(dir, dir === "next" ? startTime.hour + 1 : startTime.hour - 1);
        if (hour !== void 0) {
          return {
            hour,
            minute: dir === "next" ? this.minutes[0] : this.reversed.minutes[0],
            second: dir === "next" ? this.seconds[0] : this.reversed.seconds[0]
          };
        }
      } else {
        return {
          hour,
          minute: dir === "next" ? this.minutes[0] : this.reversed.minutes[0],
          second: dir === "next" ? this.seconds[0] : this.reversed.seconds[0]
        };
      }
    }
    return void 0;
  }
  /**
   * Find the next or previous day in the given month, starting from the given startDay
   * that matches either the day or the weekday constraint. startDay itself might also be allowed.
   */
  findAllowedDayInMonth(dir, year, month, startDay) {
    var _a, _b;
    if (startDay < 1)
      throw new Error("startDay must not be smaller than 1.");
    const daysInMonth = getDaysInMonth(year, month);
    const daysRestricted = this.days.length !== 31;
    const weekdaysRestricted = this.weekdays.length !== 7;
    if (!daysRestricted && !weekdaysRestricted) {
      if (startDay > daysInMonth) {
        return dir === "next" ? void 0 : daysInMonth;
      }
      return startDay;
    }
    let allowedDayByDays;
    if (daysRestricted) {
      allowedDayByDays = dir === "next" ? this.days.find((x) => x >= startDay) : this.reversed.days.find((x) => x <= startDay);
      if (allowedDayByDays !== void 0 && allowedDayByDays > daysInMonth) {
        allowedDayByDays = void 0;
      }
    }
    let allowedDayByWeekdays;
    if (weekdaysRestricted) {
      const startWeekday = new Date(year, month, startDay).getDay();
      const nearestAllowedWeekday = dir === "next" ? (_a = this.weekdays.find((x) => x >= startWeekday)) !== null && _a !== void 0 ? _a : this.weekdays[0] : (_b = this.reversed.weekdays.find((x) => x <= startWeekday)) !== null && _b !== void 0 ? _b : this.reversed.weekdays[0];
      if (nearestAllowedWeekday !== void 0) {
        const daysBetweenWeekdays = dir === "next" ? getDaysBetweenWeekdays(startWeekday, nearestAllowedWeekday) : getDaysBetweenWeekdays(nearestAllowedWeekday, startWeekday);
        allowedDayByWeekdays = dir === "next" ? startDay + daysBetweenWeekdays : startDay - daysBetweenWeekdays;
        if (allowedDayByWeekdays > daysInMonth || allowedDayByWeekdays < 1) {
          allowedDayByWeekdays = void 0;
        }
      }
    }
    if (allowedDayByDays !== void 0 && allowedDayByWeekdays !== void 0) {
      return dir === "next" ? Math.min(allowedDayByDays, allowedDayByWeekdays) : Math.max(allowedDayByDays, allowedDayByWeekdays);
    }
    if (allowedDayByDays !== void 0) {
      return allowedDayByDays;
    }
    if (allowedDayByWeekdays !== void 0) {
      return allowedDayByWeekdays;
    }
    return void 0;
  }
  /** Gets the next date starting from the given start date or now. */
  getNextDate(startDate = /* @__PURE__ */ new Date()) {
    const startDateElements = extractDateElements(startDate);
    let minYear = startDateElements.year;
    let startIndexMonth = this.months.findIndex((x) => x >= startDateElements.month);
    if (startIndexMonth === -1) {
      startIndexMonth = 0;
      minYear++;
    }
    const maxIterations = this.months.length * 5;
    for (let i = 0; i < maxIterations; i++) {
      const year = minYear + Math.floor((startIndexMonth + i) / this.months.length);
      const month = this.months[(startIndexMonth + i) % this.months.length];
      const isStartMonth = year === startDateElements.year && month === startDateElements.month;
      let day = this.findAllowedDayInMonth("next", year, month, isStartMonth ? startDateElements.day : 1);
      let isStartDay = isStartMonth && day === startDateElements.day;
      if (day !== void 0 && isStartDay) {
        const nextTime = this.findAllowedTime("next", startDateElements);
        if (nextTime !== void 0) {
          return new Date(year, month, day, nextTime.hour, nextTime.minute, nextTime.second);
        }
        day = this.findAllowedDayInMonth("next", year, month, day + 1);
        isStartDay = false;
      }
      if (day !== void 0 && !isStartDay) {
        return new Date(year, month, day, this.hours[0], this.minutes[0], this.seconds[0]);
      }
    }
    throw new Error("No valid next date was found.");
  }
  /** Gets the specified amount of future dates starting from the given start date or now. */
  getNextDates(amount, startDate) {
    const dates = [];
    let nextDate;
    for (let i = 0; i < amount; i++) {
      nextDate = this.getNextDate(nextDate !== null && nextDate !== void 0 ? nextDate : startDate);
      dates.push(nextDate);
    }
    return dates;
  }
  /**
   * Get an ES6 compatible iterator which iterates over the next dates starting from startDate or now.
   * The iterator runs until the optional endDate is reached or forever.
   */
  *getNextDatesIterator(startDate, endDate) {
    let nextDate;
    while (true) {
      nextDate = this.getNextDate(nextDate !== null && nextDate !== void 0 ? nextDate : startDate);
      if (endDate && endDate.getTime() < nextDate.getTime()) {
        return;
      }
      yield nextDate;
    }
  }
  /** Gets the previous date starting from the given start date or now. */
  getPrevDate(startDate = /* @__PURE__ */ new Date()) {
    const startDateElements = extractDateElements(startDate);
    let maxYear = startDateElements.year;
    let startIndexMonth = this.reversed.months.findIndex((x) => x <= startDateElements.month);
    if (startIndexMonth === -1) {
      startIndexMonth = 0;
      maxYear--;
    }
    const maxIterations = this.reversed.months.length * 5;
    for (let i = 0; i < maxIterations; i++) {
      const year = maxYear - Math.floor((startIndexMonth + i) / this.reversed.months.length);
      const month = this.reversed.months[(startIndexMonth + i) % this.reversed.months.length];
      const isStartMonth = year === startDateElements.year && month === startDateElements.month;
      let day = this.findAllowedDayInMonth("prev", year, month, isStartMonth ? startDateElements.day : (
        // Start searching from the last day of the month.
        getDaysInMonth(year, month)
      ));
      let isStartDay = isStartMonth && day === startDateElements.day;
      if (day !== void 0 && isStartDay) {
        const prevTime = this.findAllowedTime("prev", startDateElements);
        if (prevTime !== void 0) {
          return new Date(year, month, day, prevTime.hour, prevTime.minute, prevTime.second);
        }
        if (day > 1) {
          day = this.findAllowedDayInMonth("prev", year, month, day - 1);
          isStartDay = false;
        }
      }
      if (day !== void 0 && !isStartDay) {
        return new Date(year, month, day, this.reversed.hours[0], this.reversed.minutes[0], this.reversed.seconds[0]);
      }
    }
    throw new Error("No valid previous date was found.");
  }
  /** Gets the specified amount of previous dates starting from the given start date or now. */
  getPrevDates(amount, startDate) {
    const dates = [];
    let prevDate;
    for (let i = 0; i < amount; i++) {
      prevDate = this.getPrevDate(prevDate !== null && prevDate !== void 0 ? prevDate : startDate);
      dates.push(prevDate);
    }
    return dates;
  }
  /**
   * Get an ES6 compatible iterator which iterates over the previous dates starting from startDate or now.
   * The iterator runs until the optional endDate is reached or forever.
   */
  *getPrevDatesIterator(startDate, endDate) {
    let prevDate;
    while (true) {
      prevDate = this.getPrevDate(prevDate !== null && prevDate !== void 0 ? prevDate : startDate);
      if (endDate && endDate.getTime() > prevDate.getTime()) {
        return;
      }
      yield prevDate;
    }
  }
  /** Returns true when there is a cron date at the given date. */
  matchDate(date) {
    const { second, minute, hour, day, month, weekday } = extractDateElements(date);
    if (this.seconds.indexOf(second) === -1 || this.minutes.indexOf(minute) === -1 || this.hours.indexOf(hour) === -1 || this.months.indexOf(month) === -1) {
      return false;
    }
    if (this.days.length !== 31 && this.weekdays.length !== 7) {
      return this.days.indexOf(day) !== -1 || this.weekdays.indexOf(weekday) !== -1;
    }
    return this.days.indexOf(day) !== -1 && this.weekdays.indexOf(weekday) !== -1;
  }
};

// ../../../node_modules/cron-schedule/dist/cron-parser.js
var secondConstraint = {
  min: 0,
  max: 59
};
var minuteConstraint = {
  min: 0,
  max: 59
};
var hourConstraint = {
  min: 0,
  max: 23
};
var dayConstraint = {
  min: 1,
  max: 31
};
var monthConstraint = {
  min: 1,
  max: 12,
  aliases: {
    jan: "1",
    feb: "2",
    mar: "3",
    apr: "4",
    may: "5",
    jun: "6",
    jul: "7",
    aug: "8",
    sep: "9",
    oct: "10",
    nov: "11",
    dec: "12"
  }
};
var weekdayConstraint = {
  min: 0,
  max: 7,
  aliases: {
    mon: "1",
    tue: "2",
    wed: "3",
    thu: "4",
    fri: "5",
    sat: "6",
    sun: "7"
  }
};
var timeNicknames = {
  "@yearly": "0 0 1 1 *",
  "@annually": "0 0 1 1 *",
  "@monthly": "0 0 1 * *",
  "@weekly": "0 0 * * 0",
  "@daily": "0 0 * * *",
  "@hourly": "0 * * * *",
  "@minutely": "* * * * *"
};
function parseElement(element, constraint) {
  const result = /* @__PURE__ */ new Set();
  if (element === "*") {
    for (let i = constraint.min; i <= constraint.max; i = i + 1) {
      result.add(i);
    }
    return result;
  }
  const listElements = element.split(",");
  if (listElements.length > 1) {
    for (const listElement of listElements) {
      const parsedListElement = parseElement(listElement, constraint);
      for (const x of parsedListElement) {
        result.add(x);
      }
    }
    return result;
  }
  const parseSingleElement = (singleElement) => {
    var _a, _b;
    singleElement = (_b = (_a = constraint.aliases) === null || _a === void 0 ? void 0 : _a[singleElement.toLowerCase()]) !== null && _b !== void 0 ? _b : singleElement;
    const parsedElement = Number.parseInt(singleElement, 10);
    if (Number.isNaN(parsedElement)) {
      throw new Error(`Failed to parse ${element}: ${singleElement} is NaN.`);
    }
    if (parsedElement < constraint.min || parsedElement > constraint.max) {
      throw new Error(`Failed to parse ${element}: ${singleElement} is outside of constraint range of ${constraint.min} - ${constraint.max}.`);
    }
    return parsedElement;
  };
  const rangeSegments = /^(([0-9a-zA-Z]+)-([0-9a-zA-Z]+)|\*)(\/([0-9]+))?$/.exec(element);
  if (rangeSegments === null) {
    result.add(parseSingleElement(element));
    return result;
  }
  let parsedStart = rangeSegments[1] === "*" ? constraint.min : parseSingleElement(rangeSegments[2]);
  const parsedEnd = rangeSegments[1] === "*" ? constraint.max : parseSingleElement(rangeSegments[3]);
  if (constraint === weekdayConstraint && parsedStart === 7 && // this check ensures that sun-sun is not incorrectly parsed as [0,1,2,3,4,5,6]
  parsedEnd !== 7) {
    parsedStart = 0;
  }
  if (parsedStart > parsedEnd) {
    throw new Error(`Failed to parse ${element}: Invalid range (start: ${parsedStart}, end: ${parsedEnd}).`);
  }
  const step = rangeSegments[5];
  let parsedStep = 1;
  if (step !== void 0) {
    parsedStep = Number.parseInt(step, 10);
    if (Number.isNaN(parsedStep)) {
      throw new Error(`Failed to parse step: ${step} is NaN.`);
    }
    if (parsedStep < 1) {
      throw new Error(`Failed to parse step: Expected ${step} to be greater than 0.`);
    }
  }
  for (let i = parsedStart; i <= parsedEnd; i = i + parsedStep) {
    result.add(i);
  }
  return result;
}
function parseCronExpression(cronExpression) {
  var _a;
  if (typeof cronExpression !== "string") {
    throw new TypeError("Invalid cron expression: must be of type string.");
  }
  cronExpression = (_a = timeNicknames[cronExpression.toLowerCase()]) !== null && _a !== void 0 ? _a : cronExpression;
  const elements = cronExpression.split(" ").filter((elem) => elem.length > 0);
  if (elements.length < 5 || elements.length > 6) {
    throw new Error("Invalid cron expression: expected 5 or 6 elements.");
  }
  const rawSeconds = elements.length === 6 ? elements[0] : "0";
  const rawMinutes = elements.length === 6 ? elements[1] : elements[0];
  const rawHours = elements.length === 6 ? elements[2] : elements[1];
  const rawDays = elements.length === 6 ? elements[3] : elements[2];
  const rawMonths = elements.length === 6 ? elements[4] : elements[3];
  const rawWeekdays = elements.length === 6 ? elements[5] : elements[4];
  return new Cron({
    seconds: parseElement(rawSeconds, secondConstraint),
    minutes: parseElement(rawMinutes, minuteConstraint),
    hours: parseElement(rawHours, hourConstraint),
    days: parseElement(rawDays, dayConstraint),
    // months in cron are indexed by 1, but Cron expects indexes by 0, so we need to reduce all set values by one.
    months: new Set(Array.from(parseElement(rawMonths, monthConstraint)).map((x) => x - 1)),
    weekdays: new Set(Array.from(parseElement(rawWeekdays, weekdayConstraint)).map((x) => x % 7))
  });
}

// runtime/agency.ts
function validateBlueprint(bp) {
  if (!bp.name || !/^[a-zA-Z0-9_-]+$/.test(bp.name)) {
    return "Blueprint name must be alphanumeric with - or _";
  }
  if (!bp.prompt || typeof bp.prompt !== "string") {
    return "Blueprint must have a prompt";
  }
  return null;
}
function validateSchedule(req) {
  if (!req.name || typeof req.name !== "string") {
    return "Schedule must have a name";
  }
  if (!req.agentType || typeof req.agentType !== "string") {
    return "Schedule must have an agentType";
  }
  if (!req.type || !["once", "cron", "interval"].includes(req.type)) {
    return "Schedule type must be 'once', 'cron', or 'interval'";
  }
  if (req.type === "once" && !req.runAt) {
    return "One-time schedule must have runAt";
  }
  if (req.type === "cron" && !req.cron) {
    return "Cron schedule must have cron expression";
  }
  if (req.type === "interval" && !req.intervalMs) {
    return "Interval schedule must have intervalMs";
  }
  return null;
}
var AGENCY_NAME_KEY = "_agency_name";
var Agency = class extends Agent {
  constructor(ctx, env) {
    super(ctx, env);
    this._cachedAgencyName = null;
    this._router = null;
    // Shuts off agents SDK default implementation, too noisy
    this.observability = void 0;
    this.vars = PersistedObject(ctx.storage.kv, {
      prefix: "_vars:"
    });
    this.sql`
      CREATE TABLE IF NOT EXISTS blueprints (
        name TEXT PRIMARY KEY,
        data TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `;
    this.sql`
      CREATE TABLE IF NOT EXISTS agents (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        metadata TEXT,
        related_agent_id TEXT
      )
    `;
    this.sql`
      CREATE INDEX IF NOT EXISTS idx_agents_related ON agents(related_agent_id)
    `;
    this.sql`
      CREATE TABLE IF NOT EXISTS agent_schedules (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        agent_type TEXT NOT NULL,
        input TEXT,
        type TEXT NOT NULL CHECK(type IN ('once', 'cron', 'interval')),
        run_at TEXT,
        cron TEXT,
        interval_ms INTEGER,
        status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'paused', 'disabled')),
        timezone TEXT,
        max_retries INTEGER DEFAULT 3,
        timeout_ms INTEGER,
        overlap_policy TEXT NOT NULL DEFAULT 'skip' CHECK(overlap_policy IN ('skip', 'queue', 'allow')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_run_at TEXT,
        next_run_at TEXT
      )
    `;
    this.sql`
      CREATE TABLE IF NOT EXISTS schedule_runs (
        id TEXT PRIMARY KEY,
        schedule_id TEXT NOT NULL,
        agent_id TEXT,
        status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'running', 'completed', 'failed', 'skipped')),
        scheduled_at TEXT NOT NULL,
        started_at TEXT,
        completed_at TEXT,
        error TEXT,
        result TEXT,
        retry_count INTEGER DEFAULT 0,
        FOREIGN KEY (schedule_id) REFERENCES agent_schedules(id) ON DELETE CASCADE
      )
    `;
    this.sql`
      CREATE INDEX IF NOT EXISTS idx_schedule_runs_schedule_id ON schedule_runs(schedule_id)
    `;
    this.sql`
      CREATE INDEX IF NOT EXISTS idx_agent_schedules_next_run ON agent_schedules(next_run_at) WHERE status = 'active'
    `;
  }
  onStart() {
    const stored = this.ctx.storage.kv.get(AGENCY_NAME_KEY);
    if (stored) {
      this._cachedAgencyName = stored;
    } else {
      this.persistName(this.name);
    }
  }
  get exports() {
    return this.ctx.exports;
  }
  get router() {
    if (!this._router) {
      this._router = this.createRouter();
    }
    return this._router;
  }
  createRouter() {
    const router = Router();
    router.get("/blueprints", () => Response.json({ blueprints: this.listDbBlueprints() }));
    router.post("/blueprints", (req) => this.handleCreateBlueprint(req));
    router.delete("/blueprints/:name", (req) => this.handleDeleteBlueprint(req.params.name));
    router.get("/agents", () => this.handleListAgents());
    router.get("/agents/tree", () => this.handleGetAgentForest());
    router.post("/agents", (req) => this.handleCreateAgent(req));
    router.get("/agents/:agentId/tree", (req) => this.handleGetAgentTree(req.params.agentId));
    router.delete("/agents/:agentId", (req) => this.handleDeleteAgent(req.params.agentId));
    router.delete("/destroy", () => this.handleDeleteAgency());
    router.get("/schedules", () => this.handleListSchedules());
    router.post("/schedules", (req) => this.handleCreateSchedule(req));
    router.get("/schedules/:scheduleId", (req) => this.handleGetSchedule(req.params.scheduleId));
    router.patch("/schedules/:scheduleId", (req) => this.handleUpdateSchedule(req.params.scheduleId, req));
    router.delete("/schedules/:scheduleId", (req) => this.handleDeleteSchedule(req.params.scheduleId));
    router.post("/schedules/:scheduleId/pause", (req) => this.handlePauseSchedule(req.params.scheduleId));
    router.post("/schedules/:scheduleId/resume", (req) => this.handleResumeSchedule(req.params.scheduleId));
    router.post("/schedules/:scheduleId/trigger", (req) => this.handleTriggerSchedule(req.params.scheduleId));
    router.get("/schedules/:scheduleId/runs", (req) => this.handleGetScheduleRuns(req.params.scheduleId));
    router.get("/vars", () => Response.json({ vars: { ...this.vars } }));
    router.put("/vars", (req) => this.handleSetVars(req));
    router.get("/vars/:key", (req) => this.handleGetVar(req.params.key));
    router.put("/vars/:key", (req) => this.handleSetVar(req.params.key, req));
    router.delete("/vars/:key", (req) => this.handleDeleteVar(req.params.key));
    router.get("/mcp", () => this.handleListMcpServers());
    router.post("/mcp", (req) => this.handleAddMcpServer(req));
    router.delete("/mcp/:id", (req) => this.handleRemoveMcpServer(req.params.id));
    router.post("/mcp/:id/retry", (req) => this.handleRetryMcpServer(req.params.id, req));
    router.get("/mcp/tools", () => this.handleListMcpTools());
    router.post("/mcp/call", (req) => this.handleMcpToolCall(req));
    router.all("/fs/:path+", (req) => this.handleFilesystem(req, req.params.path || ""));
    router.all("/fs", (req) => this.handleFilesystem(req, ""));
    router.get("/presence", (req) => this.handlePresence(req));
    router.get("/metrics", () => this.handleGetMetrics());
    router.post("/internal/register-agent", (req) => this.handleRegisterAgent(req));
    router.get("/internal/blueprint/:name", (req) => this.handleGetInternalBlueprint(req.params.name));
    router.all("*", () => new Response("Agency endpoint not found", { status: 404 }));
    return router;
  }
  get agencyName() {
    if (this._cachedAgencyName) {
      return this._cachedAgencyName;
    }
    const stored = this.ctx.storage.kv.get(AGENCY_NAME_KEY);
    if (stored) {
      this._cachedAgencyName = stored;
      return stored;
    }
    throw new Error(
      "Agency name not found - DO never accessed via getAgentByName?"
    );
  }
  persistName(name) {
    if (this._cachedAgencyName === name) return;
    this._cachedAgencyName = name;
    this.ctx.storage.kv.put(AGENCY_NAME_KEY, name);
  }
  // ============================================================
  // HTTP Request Handler
  // ============================================================
  async onRequest(req) {
    return this.router.fetch(req);
  }
  // --- Vars Handlers ---
  async handleSetVars(req) {
    const body = await req.json();
    for (const key of Object.keys(this.vars)) {
      delete this.vars[key];
    }
    for (const [key, value] of Object.entries(body)) {
      this.vars[key] = value;
    }
    return Response.json({ ok: true, vars: { ...this.vars } });
  }
  handleGetVar(key) {
    const decodedKey = decodeURIComponent(key);
    return Response.json({ key: decodedKey, value: this.vars[decodedKey] });
  }
  async handleSetVar(key, req) {
    const decodedKey = decodeURIComponent(key);
    const body = await req.json();
    this.vars[decodedKey] = body.value;
    return Response.json({ ok: true, key: decodedKey, value: body.value });
  }
  handleDeleteVar(key) {
    const decodedKey = decodeURIComponent(key);
    delete this.vars[decodedKey];
    return Response.json({ ok: true, key: decodedKey });
  }
  handleListMcpServers() {
    const mcpState = this.getMcpServers();
    const servers = this.convertMcpStateToServers(mcpState);
    return Response.json({ servers });
  }
  async handleAddMcpServer(req) {
    const body = await req.json();
    if (!body.name || typeof body.name !== "string") {
      return new Response("Server must have a name", { status: 400 });
    }
    if (!body.url || typeof body.url !== "string") {
      return new Response("Server must have a URL", { status: 400 });
    }
    try {
      new URL(body.url);
    } catch {
      return new Response("Invalid URL", { status: 400 });
    }
    try {
      const callbackHost = new URL(req.url).origin;
      const result = await this.addMcpServer(
        body.name,
        body.url,
        callbackHost,
        "oauth",
        // Callback URL: /oauth/agency/{name}/callback
        body.headers ? { transport: { headers: body.headers } } : void 0
      );
      const mcpState = this.getMcpServers();
      const serverState = mcpState.servers[result.id];
      const server = {
        id: result.id,
        name: serverState?.name || body.name,
        url: serverState?.server_url || body.url,
        status: serverState?.state || "connecting",
        authUrl: result.authUrl
      };
      return Response.json({ server }, { status: 201 });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return new Response(`Failed to add MCP server: ${message}`, { status: 500 });
    }
  }
  async handleRemoveMcpServer(id) {
    const mcpState = this.getMcpServers();
    if (!mcpState.servers[id]) {
      return new Response("MCP server not found", { status: 404 });
    }
    try {
      await this.removeMcpServer(id);
      return Response.json({ ok: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return new Response(`Failed to remove MCP server: ${message}`, { status: 500 });
    }
  }
  async handleRetryMcpServer(id, req) {
    const mcpState = this.getMcpServers();
    const serverState = mcpState.servers[id];
    if (!serverState) {
      return new Response("MCP server not found", { status: 404 });
    }
    try {
      const name = serverState.name;
      const url = serverState.server_url;
      const callbackHost = new URL(req.url).origin;
      await this.removeMcpServer(id);
      const result = await this.addMcpServer(name, url, callbackHost, "oauth");
      const newMcpState = this.getMcpServers();
      const newServerState = newMcpState.servers[result.id];
      const server = {
        id: result.id,
        name: newServerState?.name || name,
        url: newServerState?.server_url || url,
        status: newServerState?.state || "connecting",
        authUrl: result.authUrl
      };
      return Response.json({ server });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return new Response(`Failed to retry MCP server: ${message}`, { status: 500 });
    }
  }
  /**
   * Call an MCP tool. Used by agents to proxy tool calls through the Agency.
   */
  async handleMcpToolCall(req) {
    const body = await req.json();
    if (!body.serverId || typeof body.serverId !== "string") {
      return new Response("serverId is required", { status: 400 });
    }
    if (!body.toolName || typeof body.toolName !== "string") {
      return new Response("toolName is required", { status: 400 });
    }
    const mcpState = this.getMcpServers();
    const serverState = mcpState.servers[body.serverId];
    if (!serverState) {
      return new Response(`MCP server '${body.serverId}' not found`, { status: 404 });
    }
    if (serverState.state !== "ready") {
      return new Response(
        `MCP server '${body.serverId}' is not ready (state: ${serverState.state})`,
        { status: 503 }
      );
    }
    try {
      const result = await this.mcp.callTool({
        serverId: body.serverId,
        name: body.toolName,
        arguments: body.arguments || {}
      });
      return Response.json(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return new Response(`MCP tool call failed: ${message}`, { status: 500 });
    }
  }
  /**
   * Get available MCP tools. Used by agents to discover tools from connected servers.
   */
  handleListMcpTools() {
    const mcpState = this.getMcpServers();
    const serverIdToName = /* @__PURE__ */ new Map();
    for (const [id, server] of Object.entries(mcpState.servers)) {
      if (server.state === "ready") {
        serverIdToName.set(id, server.name);
      }
    }
    const tools = mcpState.tools.filter((t) => serverIdToName.has(t.serverId)).map((t) => ({ ...t, serverName: serverIdToName.get(t.serverId) }));
    return Response.json({ tools });
  }
  /**
   * Convert SDK's MCPServersState to our McpServerConfig array
   */
  convertMcpStateToServers(mcpState) {
    return Object.entries(mcpState.servers).map(([id, server]) => ({
      id,
      name: server.name,
      url: server.server_url,
      status: server.state,
      authUrl: server.auth_url || void 0,
      error: server.error
    }));
  }
  /**
   * Get all configured MCP servers in our format.
   */
  listMcpServersConfig() {
    return this.convertMcpStateToServers(this.getMcpServers());
  }
  // --- Internal Handlers ---
  handleGetInternalBlueprint(name) {
    const rows = this.sql`
      SELECT data FROM blueprints WHERE name = ${name}
    `;
    if (rows.length > 0) {
      return Response.json(JSON.parse(rows[0].data));
    }
    return new Response(null, { status: 404 });
  }
  /**
   * Broadcast an agent event to all subscribed UI WebSocket clients.
   * Excludes agent connections (they only send, not receive).
   */
  broadcastAgentEvent(event) {
    const eventStr = JSON.stringify(event);
    for (const conn of this.getConnections()) {
      try {
        const state = conn.state;
        if (state?.isAgent) continue;
        if (!state?.agentIds || state.agentIds.includes(event.agentId)) {
          conn.send(eventStr);
        }
      } catch {
      }
    }
  }
  // ============================================================
  // WebSocket Connection Handlers
  // ============================================================
  /**
   * Handle new WebSocket connections.
   * Identifies agent connections from request headers.
   */
  onConnect(connection, ctx) {
    const agentId = ctx.request.headers.get("X-Agent-Id");
    const agentType = ctx.request.headers.get("X-Agent-Type");
    if (agentId) {
      connection.setState({ isAgent: true, agentId, agentType });
    }
  }
  /**
   * Handle incoming WebSocket messages.
   * - UI clients: subscription management (subscribe/unsubscribe)
   * - Agents: event relay
   */
  onMessage(connection, message) {
    if (typeof message !== "string") return;
    try {
      const data = JSON.parse(message);
      if (data.type === "subscribe") {
        connection.setState({ ...connection.state, agentIds: data.agentIds });
      } else if (data.type === "unsubscribe") {
        connection.setState({ ...connection.state, agentIds: void 0 });
      } else if (data.agentId && data.type) {
        this.broadcastAgentEvent(data);
      }
    } catch {
    }
  }
  // ============================================================
  // Blueprint Handlers
  // ============================================================
  listDbBlueprints() {
    const rows = this.sql`SELECT data FROM blueprints`;
    return rows.map((r) => JSON.parse(r.data));
  }
  async handleCreateBlueprint(req) {
    const bp = await req.json();
    if (!bp.name) return new Response("Missing name", { status: 400 });
    const now = (/* @__PURE__ */ new Date()).toISOString();
    const existing = this.sql`
      SELECT data FROM blueprints WHERE name = ${bp.name}
    `;
    let merged = { ...bp };
    if (existing.length > 0) {
      const prev = JSON.parse(existing[0].data);
      merged = {
        ...prev,
        ...bp,
        createdAt: prev.createdAt ?? now,
        updatedAt: now
      };
    } else {
      merged = {
        ...bp,
        status: bp.status ?? "active",
        createdAt: now,
        updatedAt: now
      };
    }
    const err = validateBlueprint(merged);
    if (err) return new Response(err, { status: 400 });
    this.sql`
      INSERT OR REPLACE INTO blueprints (name, data, updated_at)
      VALUES (${merged.name}, ${JSON.stringify(merged)}, ${Date.now()})
    `;
    return Response.json({ ok: true, name: merged.name });
  }
  handleDeleteBlueprint(name) {
    if (!name) return new Response("Missing name", { status: 400 });
    const existing = this.sql`
      SELECT data FROM blueprints WHERE name = ${name}
    `;
    if (existing.length === 0) {
      return new Response("Blueprint not found", { status: 404 });
    }
    this.sql`DELETE FROM blueprints WHERE name = ${name}`;
    return Response.json({ ok: true });
  }
  // ============================================================
  // Presence
  // ============================================================
  async handlePresence(req) {
    const url = new URL(req.url);
    const uid = url.searchParams.get("uid");
    const rows = uid ? this.sql`
          SELECT id, type FROM agents WHERE id LIKE ${"%" + uid + "%"}
        ` : this.sql`
          SELECT id, type FROM agents
        `;
    const agents = await Promise.all(
      rows.map(async (row) => {
        try {
          const stub = await getAgentByName(this.exports.HubAgent, row.id);
          const res = await stub.fetch(new Request("http://do/connections"));
          if (res.ok) {
            const data = await res.json();
            return { agentId: row.id, agentType: row.type, clients: data.connections };
          }
        } catch {
        }
        return { agentId: row.id, agentType: row.type, clients: 0 };
      })
    );
    return Response.json({ agents });
  }
  /**
   * Register an agent in the agents table so presence discovery can find it.
   * Called by the worker when a client WebSocket connects to a HubAgent DO
   * that may not have been created through POST /agents.
   */
  async handleRegisterAgent(req) {
    const { agentId, agentType } = await req.json();
    if (!agentId) return new Response("agentId required", { status: 400 });
    this.sql`
      INSERT INTO agents (id, type, created_at, metadata)
      VALUES (${agentId}, ${agentType || "unknown"}, ${Date.now()}, '{}')
      ON CONFLICT(id) DO NOTHING
    `;
    return Response.json({ ok: true });
  }
  // ============================================================
  // Agent Handlers
  // ============================================================
  handleListAgents() {
    const rows = this.sql`SELECT * FROM agents ORDER BY created_at DESC`;
    const agents = rows.map((r) => ({
      id: r.id,
      agentType: r.type,
      createdAt: new Date(r.created_at).toISOString(),
      relatedAgentId: r.related_agent_id || void 0,
      ...JSON.parse(r.metadata || "{}")
    }));
    return Response.json({ agents });
  }
  async handleCreateAgent(req) {
    const body = await req.json();
    return this.spawnAgent(body.agentType, body.requestContext, body.input, body.relatedAgentId, body.id);
  }
  async handleDeleteAgent(agentId) {
    const existing = this.sql`
      SELECT id FROM agents WHERE id = ${agentId}
    `;
    if (existing.length === 0) {
      return new Response("Agent not found", { status: 404 });
    }
    await this.deleteAgentResources(agentId);
    return Response.json({ ok: true });
  }
  /**
   * Get the tree of agents related to a specific agent.
   * Returns the agent, its ancestors (via relatedAgentId chain), and descendants.
   */
  handleGetAgentTree(agentId) {
    const targetRows = this.sql`
      SELECT * FROM agents WHERE id = ${agentId}
    `;
    if (targetRows.length === 0) {
      return new Response("Agent not found", { status: 404 });
    }
    const rowToAgent = (r) => ({
      id: r.id,
      agentType: r.type,
      createdAt: new Date(r.created_at).toISOString(),
      relatedAgentId: r.related_agent_id || void 0,
      ...JSON.parse(r.metadata || "{}")
    });
    const descendants = [];
    const queue = [agentId];
    while (queue.length > 0) {
      const parentId = queue.shift();
      const children = this.sql`
        SELECT * FROM agents WHERE related_agent_id = ${parentId}
      `;
      for (const child of children) {
        descendants.push(child);
        queue.push(child.id);
      }
    }
    const ancestors = [];
    let current = targetRows[0];
    while (current.related_agent_id) {
      const parentRows = this.sql`
        SELECT * FROM agents WHERE id = ${current.related_agent_id}
      `;
      if (parentRows.length === 0) break;
      ancestors.unshift(parentRows[0]);
      current = parentRows[0];
    }
    return Response.json({
      agent: rowToAgent(targetRows[0]),
      ancestors: ancestors.map(rowToAgent),
      descendants: descendants.map(rowToAgent)
    });
  }
  /**
   * Get the full forest of agents organized as trees.
   * Root agents are those without a relatedAgentId.
   */
  handleGetAgentForest() {
    const allAgents = this.sql`
      SELECT * FROM agents ORDER BY created_at ASC
    `;
    const agentMap = /* @__PURE__ */ new Map();
    for (const r of allAgents) {
      const meta = JSON.parse(r.metadata || "{}");
      agentMap.set(r.id, {
        id: r.id,
        agentType: r.type,
        createdAt: new Date(r.created_at).toISOString(),
        relatedAgentId: r.related_agent_id || void 0,
        children: [],
        ...meta
      });
    }
    const roots = [];
    for (const agent of agentMap.values()) {
      if (agent.relatedAgentId && agentMap.has(agent.relatedAgentId)) {
        agentMap.get(agent.relatedAgentId).children.push(agent);
      } else {
        roots.push(agent);
      }
    }
    return Response.json({ roots });
  }
  async spawnAgent(agentType, requestContext, input, relatedAgentId, providedId) {
    const id = providedId || crypto.randomUUID();
    const createdAt = Date.now();
    if (providedId) {
      const existing = this.sql`
        SELECT id FROM agents WHERE id = ${providedId}
      `;
      if (existing.length > 0) {
        const stub2 = await getAgentByName(this.exports.HubAgent, providedId);
        if (input) {
          const userMessage = typeof input.message === "string" ? input.message : JSON.stringify(input);
          await stub2.fetch(
            new Request("http://do/invoke", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                messages: [{ role: "user", content: userMessage }]
              })
            })
          );
        }
        const meta2 = this.sql`
          SELECT metadata, created_at FROM agents WHERE id = ${providedId}
        `[0];
        return Response.json({
          id: providedId,
          createdAt: new Date(meta2.created_at).toISOString(),
          agentType,
          resumed: true
        }, { status: 200 });
      }
    }
    const meta = {
      request: requestContext,
      agencyId: this.agencyName,
      input,
      relatedAgentId
    };
    this.sql`
      INSERT INTO agents (id, type, created_at, metadata, related_agent_id)
      VALUES (${id}, ${agentType}, ${createdAt}, ${JSON.stringify(meta)}, ${relatedAgentId ?? null})
    `;
    const stub = await getAgentByName(this.exports.HubAgent, id);
    const mcpServers = this.listMcpServersConfig();
    const varsWithMcp = {
      ...this.vars,
      MCP_SERVERS: mcpServers.length > 0 ? mcpServers : void 0
    };
    const initPayload = {
      id,
      createdAt: new Date(createdAt).toISOString(),
      agentType,
      request: requestContext ?? {},
      agencyId: this.agencyName,
      vars: varsWithMcp
    };
    const res = await stub.fetch(
      new Request("http://do/register", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(initPayload)
      })
    );
    if (!res.ok) {
      this.sql`DELETE FROM agents WHERE id = ${id}`;
      return res;
    }
    if (input) {
      const userMessage = typeof input.message === "string" ? input.message : JSON.stringify(input);
      await stub.fetch(
        new Request("http://do/invoke", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            messages: [{ role: "user", content: userMessage }]
          })
        })
      );
    }
    return Response.json(initPayload, { status: 201 });
  }
  // ============================================================
  // Schedule Handlers
  // ============================================================
  handleListSchedules() {
    const rows = this.sql`
      SELECT * FROM agent_schedules ORDER BY created_at DESC
    `;
    return Response.json({ schedules: rows.map(rowToSchedule) });
  }
  async handleCreateSchedule(req) {
    const body = await req.json();
    const err = validateSchedule(body);
    if (err) return new Response(err, { status: 400 });
    const id = crypto.randomUUID();
    const now = (/* @__PURE__ */ new Date()).toISOString();
    const nextRunAt = this.computeNextRun(body);
    this.sql`
      INSERT INTO agent_schedules (
        id, name, agent_type, input, type, run_at, cron, interval_ms,
        status, timezone, max_retries, timeout_ms, overlap_policy,
        created_at, updated_at, next_run_at
      ) VALUES (
        ${id},
        ${body.name},
        ${body.agentType},
        ${body.input ? JSON.stringify(body.input) : null},
        ${body.type},
        ${body.runAt || null},
        ${body.cron || null},
        ${body.intervalMs || null},
        ${"active"},
        ${body.timezone || null},
        ${body.maxRetries ?? 3},
        ${body.timeoutMs || null},
        ${body.overlapPolicy || "skip"},
        ${now},
        ${now},
        ${nextRunAt}
      )
    `;
    if (nextRunAt) {
      await this.schedule(new Date(nextRunAt), "runScheduledAgent", { id });
    }
    const schedule = this.getScheduleById(id);
    return Response.json({ schedule }, { status: 201 });
  }
  handleGetSchedule(id) {
    const schedule = this.getScheduleById(id);
    if (!schedule) {
      return new Response("Schedule not found", { status: 404 });
    }
    return Response.json({ schedule });
  }
  async handleUpdateSchedule(id, req) {
    const existing = this.getScheduleById(id);
    if (!existing) {
      return new Response("Schedule not found", { status: 404 });
    }
    const updates = await req.json();
    const now = (/* @__PURE__ */ new Date()).toISOString();
    const merged = { ...existing, ...updates, updatedAt: now };
    const nextRunAt = updates.type || updates.runAt || updates.cron || updates.intervalMs ? this.computeNextRun(merged) : existing.nextRunAt;
    this.sql`
      UPDATE agent_schedules SET
        name = ${merged.name},
        agent_type = ${merged.agentType},
        input = ${merged.input ? JSON.stringify(merged.input) : null},
        type = ${merged.type},
        run_at = ${merged.runAt || null},
        cron = ${merged.cron || null},
        interval_ms = ${merged.intervalMs || null},
        timezone = ${merged.timezone || null},
        max_retries = ${merged.maxRetries ?? 3},
        timeout_ms = ${merged.timeoutMs || null},
        overlap_policy = ${merged.overlapPolicy || "skip"},
        updated_at = ${now},
        next_run_at = ${nextRunAt || null}
      WHERE id = ${id}
    `;
    return Response.json({ schedule: this.getScheduleById(id) });
  }
  handleDeleteSchedule(id) {
    const existing = this.getScheduleById(id);
    if (!existing) {
      return new Response("Schedule not found", { status: 404 });
    }
    this.sql`DELETE FROM agent_schedules WHERE id = ${id}`;
    this.sql`DELETE FROM schedule_runs WHERE schedule_id = ${id}`;
    return Response.json({ ok: true });
  }
  handlePauseSchedule(id) {
    const existing = this.getScheduleById(id);
    if (!existing) {
      return new Response("Schedule not found", { status: 404 });
    }
    this.sql`
      UPDATE agent_schedules SET status = 'paused', updated_at = ${(/* @__PURE__ */ new Date()).toISOString()}
      WHERE id = ${id}
    `;
    return Response.json({ schedule: this.getScheduleById(id) });
  }
  async handleResumeSchedule(id) {
    const existing = this.getScheduleById(id);
    if (!existing) {
      return new Response("Schedule not found", { status: 404 });
    }
    const now = (/* @__PURE__ */ new Date()).toISOString();
    const nextRunAt = this.computeNextRun(existing);
    this.sql`
      UPDATE agent_schedules SET
        status = 'active',
        updated_at = ${now},
        next_run_at = ${nextRunAt || null}
      WHERE id = ${id}
    `;
    if (nextRunAt) {
      await this.schedule(new Date(nextRunAt), "runScheduledAgent", { id });
    }
    return Response.json({ schedule: this.getScheduleById(id) });
  }
  async handleTriggerSchedule(id) {
    const existing = this.getScheduleById(id);
    if (!existing) {
      return new Response("Schedule not found", { status: 404 });
    }
    const run = await this.executeSchedule(existing, true);
    return Response.json({ run });
  }
  handleGetScheduleRuns(scheduleId) {
    const runs = this.sql`
      SELECT * FROM schedule_runs
      WHERE schedule_id = ${scheduleId}
      ORDER BY scheduled_at DESC
      LIMIT 100
    `;
    return Response.json({ runs: runs.map(rowToRun) });
  }
  // ============================================================
  // Schedule Execution
  // ============================================================
  /**
   * Callback method invoked by Agent's alarm system
   */
  async runScheduledAgent(payload) {
    const schedule = this.getScheduleById(payload.id);
    if (!schedule) {
      console.warn(`Schedule ${payload.id} not found, skipping`);
      return;
    }
    if (schedule.status !== "active") {
      console.log(`Schedule ${payload.id} is ${schedule.status}, skipping`);
      return;
    }
    if (schedule.overlapPolicy === "skip") {
      const runningRuns = this.sql`
        SELECT COUNT(*) as count FROM schedule_runs
        WHERE schedule_id = ${schedule.id} AND status = 'running'
      `;
      if (runningRuns[0]?.count > 0) {
        console.log(
          `Schedule ${schedule.id} has running instance, skipping (overlap=skip)`
        );
        await this.scheduleNextRun(schedule);
        return;
      }
    }
    await this.executeSchedule(schedule, false);
    await this.scheduleNextRun(schedule);
  }
  async executeSchedule(schedule, isManual) {
    const runId = crypto.randomUUID();
    const now = (/* @__PURE__ */ new Date()).toISOString();
    this.sql`
      INSERT INTO schedule_runs (id, schedule_id, status, scheduled_at, started_at, retry_count)
      VALUES (${runId}, ${schedule.id}, 'running', ${now}, ${now}, ${0})
    `;
    this.sql`
      UPDATE agent_schedules SET last_run_at = ${now} WHERE id = ${schedule.id}
    `;
    try {
      const res = await this.spawnAgent(
        schedule.agentType,
        void 0,
        schedule.input
      );
      if (!res.ok) {
        throw new Error(`Failed to spawn agent: ${res.status}`);
      }
      const agentData = await res.json();
      this.sql`
        UPDATE schedule_runs SET
          agent_id = ${agentData.id},
          status = 'completed',
          completed_at = ${(/* @__PURE__ */ new Date()).toISOString()}
        WHERE id = ${runId}
      `;
      return this.getRunById(runId);
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      this.sql`
        UPDATE schedule_runs SET
          status = 'failed',
          completed_at = ${(/* @__PURE__ */ new Date()).toISOString()},
          error = ${errorMsg}
        WHERE id = ${runId}
      `;
      console.error(`Schedule ${schedule.id} execution failed:`, errorMsg);
      return this.getRunById(runId);
    }
  }
  async scheduleNextRun(schedule) {
    if (schedule.type === "once") {
      this.sql`
        UPDATE agent_schedules SET status = 'disabled' WHERE id = ${schedule.id}
      `;
      return;
    }
    const nextRunAt = this.computeNextRun(schedule);
    if (nextRunAt) {
      this.sql`
        UPDATE agent_schedules SET next_run_at = ${nextRunAt} WHERE id = ${schedule.id}
      `;
      await this.schedule(new Date(nextRunAt), "runScheduledAgent", {
        id: schedule.id
      });
    }
  }
  async handleDeleteAgency() {
    const agents = this.sql`SELECT id FROM agents`;
    for (const { id } of agents) {
      await this.deleteAgentResources(id);
    }
    const bucket = this.env.FS;
    if (bucket) {
      await this.deletePrefix(bucket, `${this.agencyName}/`);
    }
    await this.destroy();
    return Response.json({ ok: true });
  }
  // ============================================================
  // Helper Methods
  // ============================================================
  getScheduleById(id) {
    const rows = this.sql`
      SELECT * FROM agent_schedules WHERE id = ${id}
    `;
    return rows.length > 0 ? rowToSchedule(rows[0]) : null;
  }
  getRunById(id) {
    const rows = this.sql`
      SELECT * FROM schedule_runs WHERE id = ${id}
    `;
    return rows.length > 0 ? rowToRun(rows[0]) : null;
  }
  async deleteAgentResources(agentId) {
    const agentRows = this.sql`
      SELECT type FROM agents WHERE id = ${agentId}
    `;
    agentRows[0]?.type;
    try {
      const stub = await getAgentByName(this.exports.HubAgent, agentId);
      await stub.fetch(
        new Request("http://do/destroy", { method: "DELETE" })
      );
    } catch (err) {
      console.warn(`Failed to destroy agent ${agentId}:`, err);
    }
    const bucket = this.env.FS;
    if (bucket) {
      await this.deletePrefix(bucket, `${this.agencyName}/agents/${agentId}/`);
      await bucket.delete(`${this.agencyName}/agents/${agentId}`).catch(() => {
      });
    }
    this.sql`
      UPDATE schedule_runs SET agent_id = NULL WHERE agent_id = ${agentId}
    `;
    this.sql`DELETE FROM agents WHERE id = ${agentId}`;
  }
  async deletePrefix(bucket, prefix) {
    if (!bucket) return;
    let cursor;
    do {
      const list = await bucket.list({ prefix, cursor });
      if (list.objects.length > 0) {
        await bucket.delete(list.objects.map((o) => o.key));
      }
      cursor = list.truncated ? list.cursor : void 0;
    } while (cursor);
  }
  computeNextRun(schedule) {
    const now = /* @__PURE__ */ new Date();
    switch (schedule.type) {
      case "once":
        if (schedule.runAt) {
          const runAt = new Date(schedule.runAt);
          return runAt > now ? schedule.runAt : null;
        }
        return null;
      case "cron":
        if (schedule.cron) {
          try {
            const interval = parseCronExpression(schedule.cron);
            return interval.getNextDate().toISOString();
          } catch (e) {
            console.error("Failed to parse cron expression:", e);
            return null;
          }
        }
        return null;
      case "interval":
        if (schedule.intervalMs) {
          const base = schedule.lastRunAt ? new Date(schedule.lastRunAt) : now;
          return new Date(base.getTime() + schedule.intervalMs).toISOString();
        }
        return null;
      default:
        return null;
    }
  }
  // ============================================================
  // Filesystem Handlers
  // ============================================================
  /**
   * Handle filesystem requests.
   * Routes:
   *   GET  /fs/...          - List directory or read file
   *   PUT  /fs/...          - Write file (body = content)
   *   DELETE /fs/...        - Delete file
   *
   * Paths map to R2: /fs/shared/... → {agencyId}/shared/...
   *                  /fs/agents/... → {agencyId}/agents/...
   */
  async handleFilesystem(req, fsPath) {
    const bucket = this.env.FS;
    if (!bucket) {
      return new Response("Filesystem not configured (missing FS binding)", {
        status: 503
      });
    }
    const r2Prefix = this.agencyName + "/";
    const r2Key = r2Prefix + fsPath;
    switch (req.method) {
      case "GET":
        return this.handleFsGet(bucket, r2Key, r2Prefix, fsPath);
      case "PUT":
        return this.handleFsPut(bucket, r2Key, fsPath, req);
      case "DELETE":
        return this.handleFsDelete(bucket, r2Key, fsPath);
      default:
        return new Response("Method not allowed", { status: 405 });
    }
  }
  async handleFsGet(bucket, r2Key, r2Prefix, fsPath) {
    const obj = await bucket.get(r2Key);
    if (obj) {
      const content = await obj.text();
      return new Response(content, {
        headers: {
          "content-type": "text/plain; charset=utf-8",
          "x-fs-path": "/" + fsPath,
          "x-fs-size": String(obj.size),
          "x-fs-modified": obj.uploaded.toISOString()
        }
      });
    }
    const prefix = r2Key.endsWith("/") ? r2Key : r2Key + "/";
    const list = await bucket.list({ prefix, delimiter: "/" });
    const entries = [];
    for (const p of list.delimitedPrefixes) {
      const relPath = p.slice(r2Prefix.length);
      entries.push({ type: "dir", path: "/" + relPath });
    }
    for (const obj2 of list.objects) {
      if (obj2.key === r2Key) continue;
      const relPath = obj2.key.slice(r2Prefix.length);
      entries.push({
        type: "file",
        path: "/" + relPath,
        size: obj2.size,
        modified: obj2.uploaded.toISOString()
      });
    }
    entries.sort((a, b) => {
      if (a.type !== b.type) return a.type === "dir" ? -1 : 1;
      return a.path.localeCompare(b.path);
    });
    return Response.json({
      path: "/" + fsPath || "/",
      entries
    });
  }
  async handleFsPut(bucket, r2Key, fsPath, req) {
    if (!fsPath) {
      return new Response("Cannot write to root", { status: 400 });
    }
    const content = await req.text();
    await bucket.put(r2Key, content);
    return Response.json({
      ok: true,
      path: "/" + fsPath,
      size: content.length
    });
  }
  async handleFsDelete(bucket, r2Key, fsPath) {
    if (!fsPath) {
      return new Response("Cannot delete root", { status: 400 });
    }
    await bucket.delete(r2Key);
    return Response.json({
      ok: true,
      path: "/" + fsPath
    });
  }
  // ============================================================
  // Metrics Handlers
  // ============================================================
  /**
   * Get aggregated metrics for this agency.
   * Returns counts and stats computed from local state (schedules, agents).
   * 
   * Note: For full Analytics Engine queries, use the SQL API directly with
   * ACCOUNT_ID and API_TOKEN. This endpoint provides basic real-time counts.
   */
  handleGetMetrics() {
    const agentCounts = this.sql`
      SELECT COUNT(*) as total FROM agents
    `;
    const totalAgents = agentCounts[0]?.total ?? 0;
    const agentsByType = this.sql`
      SELECT type, COUNT(*) as count FROM agents GROUP BY type
    `;
    const scheduleCounts = this.sql`
      SELECT status, COUNT(*) as count FROM agent_schedules GROUP BY status
    `;
    const schedulesByStatus = {};
    for (const row of scheduleCounts) {
      schedulesByStatus[row.status] = row.count;
    }
    const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1e3).toISOString();
    const recentRuns = this.sql`
      SELECT status, COUNT(*) as count 
      FROM schedule_runs 
      WHERE scheduled_at >= ${oneDayAgo}
      GROUP BY status
    `;
    const runsByStatus = {};
    let totalRuns = 0;
    for (const row of recentRuns) {
      runsByStatus[row.status] = row.count;
      totalRuns += row.count;
    }
    const completedRuns = runsByStatus["completed"] ?? 0;
    const successRate = totalRuns > 0 ? Math.round(completedRuns / totalRuns * 100) : 100;
    return Response.json({
      agents: {
        total: totalAgents,
        byType: Object.fromEntries(agentsByType.map((r) => [r.type, r.count]))
      },
      schedules: {
        total: Object.values(schedulesByStatus).reduce((a, b) => a + b, 0),
        active: schedulesByStatus["active"] ?? 0,
        paused: schedulesByStatus["paused"] ?? 0,
        disabled: schedulesByStatus["disabled"] ?? 0
      },
      runs: {
        today: totalRuns,
        completed: completedRuns,
        failed: runsByStatus["failed"] ?? 0,
        successRate
      },
      timestamp: (/* @__PURE__ */ new Date()).toISOString()
    });
  }
};
function rowToSchedule(row) {
  return {
    id: row.id,
    name: row.name,
    agentType: row.agent_type,
    input: row.input ? JSON.parse(row.input) : void 0,
    type: row.type,
    runAt: row.run_at || void 0,
    cron: row.cron || void 0,
    intervalMs: row.interval_ms || void 0,
    status: row.status,
    timezone: row.timezone || void 0,
    maxRetries: row.max_retries,
    timeoutMs: row.timeout_ms || void 0,
    overlapPolicy: row.overlap_policy,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastRunAt: row.last_run_at || void 0,
    nextRunAt: row.next_run_at || void 0
  };
}
function rowToRun(row) {
  return {
    id: row.id,
    scheduleId: row.schedule_id,
    agentId: row.agent_id || void 0,
    status: row.status,
    scheduledAt: row.scheduled_at,
    startedAt: row.started_at || void 0,
    completedAt: row.completed_at || void 0,
    error: row.error || void 0,
    result: row.result || void 0,
    retryCount: row.retry_count
  };
}

// runtime/hub.ts
function readNumberVar(value, fallback) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.length > 0 && Number.isFinite(Number(trimmed))) {
      return Number(trimmed);
    }
  }
  return fallback;
}
function readStatusCodesVar(value, fallback) {
  if (Array.isArray(value)) {
    const codes = value.map((v) => readNumberVar(v, NaN)).filter((v) => Number.isFinite(v));
    if (codes.length > 0) return codes;
  }
  if (typeof value === "string") {
    const codes = value.split(",").map((v) => readNumberVar(v, NaN)).filter((v) => Number.isFinite(v));
    if (codes.length > 0) return codes;
  }
  return fallback;
}
function createMcpProxyTool(toolInfo, agencyId) {
  const toolName = `mcp_${toolInfo.serverId}_${toolInfo.name}`;
  return {
    meta: {
      name: toolName,
      description: toolInfo.description || `MCP tool: ${toolInfo.name} (server: ${toolInfo.serverId})`,
      parameters: toolInfo.inputSchema || { type: "object", properties: {} }
    },
    tags: ["mcp", `mcp:${toolInfo.serverId}`],
    execute: async (args, ctx) => {
      const agencyStub = await getAgentByName(ctx.agent.exports.Agency, agencyId);
      const request = {
        serverId: toolInfo.serverId,
        toolName: toolInfo.name,
        arguments: args
      };
      const res = await agencyStub.fetch(
        new Request("http://do/mcp/call", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(request)
        })
      );
      if (!res.ok) {
        const errorText = await res.text();
        throw new Error(`MCP tool call failed: ${errorText}`);
      }
      const result = await res.json();
      if (result.isError) {
        const errorContent = result.content?.find((c) => c.type === "text");
        throw new Error(errorContent?.text || "MCP tool returned an error");
      }
      if (result.content) {
        const textParts = result.content.filter((c) => c.type === "text").map((c) => c.text).filter(Boolean);
        return textParts.join("\n") || JSON.stringify(result.content);
      }
      if (result.toolResult !== void 0) {
        return typeof result.toolResult === "string" ? result.toolResult : JSON.stringify(result.toolResult);
      }
      return "Tool completed with no output";
    }
  };
}
function filterMcpToolsByCapabilities(tools, capabilities) {
  const mcpCaps = capabilities.filter((c) => c.startsWith("mcp:"));
  if (mcpCaps.length === 0) return [];
  const selected = [];
  const seen = /* @__PURE__ */ new Set();
  for (const cap of mcpCaps) {
    const parts = cap.split(":");
    if (parts[1] === "*") {
      for (const tool2 of tools) {
        const key = `${tool2.serverId}:${tool2.name}`;
        if (!seen.has(key)) {
          seen.add(key);
          selected.push(tool2);
        }
      }
    } else if (parts.length === 2) {
      const serverIdOrName = parts[1];
      for (const tool2 of tools) {
        if (tool2.serverId === serverIdOrName || tool2.serverName === serverIdOrName) {
          const key = `${tool2.serverId}:${tool2.name}`;
          if (!seen.has(key)) {
            seen.add(key);
            selected.push(tool2);
          }
        }
      }
    } else if (parts.length >= 3) {
      const serverIdOrName = parts[1];
      const toolName = parts.slice(2).join(":");
      for (const tool2 of tools) {
        if ((tool2.serverId === serverIdOrName || tool2.serverName === serverIdOrName) && tool2.name === toolName) {
          const key = `${tool2.serverId}:${tool2.name}`;
          if (!seen.has(key)) {
            seen.add(key);
            selected.push(tool2);
          }
        }
      }
    }
  }
  return selected;
}
var ToolRegistry = class {
  constructor() {
    this.tools = /* @__PURE__ */ new Map();
    this.tags = /* @__PURE__ */ new Map();
    this.toolTags = /* @__PURE__ */ new Map();
  }
  addTool(name, tool2, tags) {
    this.tools.set(name, tool2);
    const intrinsicTags = tool2.tags ?? [];
    const allTags = [.../* @__PURE__ */ new Set([...intrinsicTags, ...tags ?? []])];
    if (allTags.length > 0) {
      this.toolTags.set(name, allTags);
      for (const tag of allTags) {
        const existing = this.tags.get(tag) || [];
        existing.push(name);
        this.tags.set(tag, existing);
      }
    }
  }
  getAll() {
    const result = [];
    for (const [name, tool2] of this.tools) {
      result.push({
        name,
        description: tool2.meta.description,
        tags: this.toolTags.get(name) ?? [],
        varHints: tool2.varHints?.length ? tool2.varHints : void 0
      });
    }
    return result;
  }
  selectByCapabilities(capabilities) {
    const seen = /* @__PURE__ */ new Set();
    const selected = [];
    for (const cap of capabilities) {
      if (cap.startsWith("@")) {
        const toolNames = this.tags.get(cap) || [];
        for (const name of toolNames) {
          if (!seen.has(name)) {
            seen.add(name);
            const handler = this.tools.get(name);
            if (handler) selected.push(handler);
          }
        }
      } else {
        if (!seen.has(cap)) {
          seen.add(cap);
          const handler = this.tools.get(cap);
          if (handler) {
            selected.push(handler);
          }
        }
      }
    }
    return selected;
  }
};
var PluginRegistry = class {
  constructor() {
    this.plugins = /* @__PURE__ */ new Map();
    this.tags = /* @__PURE__ */ new Map();
  }
  addPlugin(name, handler, tags) {
    this.plugins.set(name, handler);
    if (tags) {
      for (const tag of tags) {
        const existing = this.tags.get(tag) || [];
        existing.push(name);
        this.tags.set(tag, existing);
      }
    }
  }
  getAll() {
    const result = [];
    for (const [name, plugin] of this.plugins) {
      result.push({
        name,
        tags: plugin.tags,
        varHints: plugin.varHints?.length ? plugin.varHints : void 0
      });
    }
    return result;
  }
  selectByCapabilities(capabilities) {
    const seen = /* @__PURE__ */ new Set();
    const selected = [];
    for (const cap of capabilities) {
      if (cap.startsWith("@")) {
        const tag = cap.slice(1);
        const pluginNames = this.tags.get(tag) || [];
        for (const name of pluginNames) {
          if (!seen.has(name)) {
            seen.add(name);
            const handler = this.plugins.get(name);
            if (handler) selected.push(handler);
          }
        }
      } else {
        if (!seen.has(cap)) {
          seen.add(cap);
          const handler = this.plugins.get(cap);
          if (handler) {
            selected.push(handler);
          }
        }
      }
    }
    return selected;
  }
};
var AgentHub = class {
  constructor(options) {
    this.options = options;
    this.toolRegistry = new ToolRegistry();
    this.pluginRegistry = new PluginRegistry();
    this.agentRegistry = /* @__PURE__ */ new Map();
    this.defaultVars = {};
  }
  /** Register a tool with optional tags for capability-based selection. */
  addTool(tool2, tags) {
    this.toolRegistry.addTool(tool2.meta.name, tool2, tags);
    return this;
  }
  /** Register a plugin with optional additional tags. */
  use(plugin, tags) {
    const uniqueTags = Array.from(/* @__PURE__ */ new Set([...tags || [], ...plugin.tags]));
    this.pluginRegistry.addPlugin(plugin.name, plugin, uniqueTags);
    return this;
  }
  /** Register a static agent blueprint. */
  addAgent(blueprint) {
    this.agentRegistry.set(blueprint.name, blueprint);
    return this;
  }
  /** Export the configured Durable Object classes and HTTP handler. */
  export() {
    const options = this.options;
    const { toolRegistry, pluginRegistry, agentRegistry } = this;
    class ConfiguredHubAgent extends HubAgent {
      get blueprint() {
        if (this.info.blueprint) return this.info.blueprint;
        if (!this.info.agentType) throw new Error("Agent type not set");
        const staticBp = agentRegistry.get(this.info.agentType);
        if (staticBp) return staticBp;
        throw new Error(`Agent type ${this.info.agentType} not found`);
      }
      getStaticBlueprints() {
        return Array.from(agentRegistry.values());
      }
      getRegisteredPlugins() {
        return pluginRegistry.getAll();
      }
      getRegisteredTools() {
        return toolRegistry.getAll();
      }
      async onRegister(meta) {
        const type = meta.agentType;
        const agencyId = meta.agencyId;
        if (!agencyId) {
          throw new Error("Cannot register agent without Agency ID");
        }
        this.info.agencyId = agencyId;
        if (options.defaultModel && !this.vars.DEFAULT_MODEL) {
          this.vars.DEFAULT_MODEL = options.defaultModel;
        }
        let bp;
        const agencyStub = await getAgentByName(
          this.exports.Agency,
          agencyId
        );
        try {
          const res = await agencyStub.fetch(
            `http://do/internal/blueprint/${type}`
          );
          if (res.ok) {
            bp = await res.json();
          }
        } catch (e) {
          console.warn("Failed to fetch blueprint from Agency DO", e);
        }
        if (!bp) bp = agentRegistry.get(type);
        if (!bp) throw new Error(`Unknown agent type: ${type}`);
        this.info.blueprint = bp;
        if (bp.vars) {
          Object.assign(this.vars, bp.vars);
        }
        for (const p of this.plugins) {
          await p.onInit?.(this.pluginContext);
        }
      }
      /**
       * Refresh MCP tools from the Agency.
       * Called before each model invocation to ensure tools are available
       * even after agent eviction/restart.
       */
      async refreshMcpTools() {
        const agencyId = this.info.agencyId;
        if (!agencyId) return;
        const blueprint = this.blueprint;
        const hasMcpCaps = blueprint.capabilities.some((c) => c.startsWith("mcp:"));
        if (!hasMcpCaps) return;
        try {
          const agencyStub = await getAgentByName(this.exports.Agency, agencyId);
          const mcpToolsRes = await agencyStub.fetch("http://do/mcp/tools");
          if (!mcpToolsRes.ok) {
            console.warn("[MCP] Failed to fetch tools:", mcpToolsRes.status);
            return;
          }
          const { tools: mcpTools } = await mcpToolsRes.json();
          const filteredTools = filterMcpToolsByCapabilities(mcpTools, blueprint.capabilities);
          for (const key of Object.keys(this._tools)) {
            if (key.startsWith("mcp_")) {
              delete this._tools[key];
            }
          }
          for (const toolInfo of filteredTools) {
            const proxyTool = createMcpProxyTool(toolInfo, agencyId);
            this._tools[proxyTool.meta.name] = proxyTool;
          }
        } catch (e) {
          console.warn("[MCP] Failed to refresh tools:", e);
        }
      }
      get tools() {
        const blueprint = this.blueprint;
        const tools = toolRegistry.selectByCapabilities(blueprint.capabilities);
        return {
          ...Object.fromEntries(tools.map((t) => [t.meta.name, t])),
          ...this._tools
        };
      }
      get plugins() {
        const blueprint = this.blueprint;
        const basePlugins = pluginRegistry.selectByCapabilities(blueprint.capabilities);
        const hasMcpCaps = blueprint.capabilities.some((c) => c.startsWith("mcp:"));
        if (hasMcpCaps) {
          const mcpInjectorPlugin = {
            name: "_mcp-injector",
            tags: [],
            beforeModel: async () => {
              await this.refreshMcpTools();
            }
          };
          return [mcpInjectorPlugin, ...basePlugins];
        }
        return basePlugins;
      }
      get provider() {
        let baseProvider = options?.provider;
        if (!baseProvider) {
          const apiKey = this.vars.LLM_API_KEY ?? this.env.LLM_API_KEY;
          const apiBase = this.vars.LLM_API_BASE ?? this.env.LLM_API_BASE ?? DEFAULT_LLM_API_BASE;
          if (!apiKey)
            throw new Error("Neither LLM_API_KEY nor custom provider set");
          const retry = {
            maxRetries: readNumberVar(
              this.vars.LLM_RETRY_MAX ?? this.env.LLM_RETRY_MAX,
              DEFAULT_LLM_RETRY_MAX
            ),
            backoffMs: readNumberVar(
              this.vars.LLM_RETRY_BACKOFF_MS ?? this.env.LLM_RETRY_BACKOFF_MS,
              DEFAULT_LLM_RETRY_BACKOFF_MS
            ),
            maxBackoffMs: readNumberVar(
              this.vars.LLM_RETRY_MAX_BACKOFF_MS ?? this.env.LLM_RETRY_MAX_BACKOFF_MS,
              DEFAULT_LLM_RETRY_MAX_BACKOFF_MS
            ),
            jitterRatio: readNumberVar(
              this.vars.LLM_RETRY_JITTER_RATIO ?? this.env.LLM_RETRY_JITTER_RATIO,
              DEFAULT_LLM_RETRY_JITTER_RATIO
            ),
            retryableStatusCodes: readStatusCodesVar(
              this.vars.LLM_RETRY_STATUS_CODES ?? this.env.LLM_RETRY_STATUS_CODES,
              DEFAULT_LLM_RETRY_STATUS_CODES
            )
          };
          baseProvider = makeChatCompletions(apiKey, apiBase, { retry });
        }
        return {
          invoke: async (req, opts) => {
            this.emit("gen_ai.chat.start" /* CHAT_START */, {
              "gen_ai.request.model": req.model
            });
            let out;
            try {
              out = await baseProvider.stream(req, (d) => {
                this.emit("gen_ai.chat.chunk" /* CHAT_CHUNK */, { "gen_ai.content.chunk": d });
              });
            } catch (e) {
              if (e?.message?.includes?.("not implemented")) {
                out = await baseProvider.invoke(req, opts);
              } else {
                throw e;
              }
            }
            this.emit("gen_ai.chat.finish" /* CHAT_FINISH */, {
              "gen_ai.usage.input_tokens": out.usage?.promptTokens ?? 0,
              "gen_ai.usage.output_tokens": out.usage?.completionTokens ?? 0
            });
            return out;
          },
          stream: async (req, onDelta) => {
            this.emit("gen_ai.chat.start" /* CHAT_START */, {
              "gen_ai.request.model": req.model
            });
            const out = await baseProvider.stream(req, (d) => {
              this.emit("gen_ai.chat.chunk" /* CHAT_CHUNK */, { "gen_ai.content.chunk": d });
              onDelta(d);
            });
            this.emit("gen_ai.chat.finish" /* CHAT_FINISH */, {
              "gen_ai.usage.input_tokens": out.usage?.promptTokens ?? 0,
              "gen_ai.usage.output_tokens": out.usage?.completionTokens ?? 0
            });
            return out;
          }
        };
      }
    }
    const handlerOptions = {};
    handlerOptions.agentDefinitions = Array.from(this.agentRegistry.values());
    handlerOptions.plugins = pluginRegistry.getAll();
    handlerOptions.tools = toolRegistry.getAll();
    const handler = createHandler(handlerOptions);
    return { HubAgent: ConfiguredHubAgent, Agency, handler };
  }
};
function isZodSchema(value) {
  return typeof value === "object" && value !== null && "_def" in value && "parse" in value;
}
function tool(config) {
  let jsonSchema;
  if (isZodSchema(config.inputSchema)) {
    jsonSchema = zodToJsonSchema(config.inputSchema, {
      $refStrategy: "none",
      target: "openApi3"
    });
    delete jsonSchema.$schema;
  } else {
    jsonSchema = config.inputSchema;
  }
  return {
    meta: {
      name: config.name,
      description: config.description,
      parameters: jsonSchema
    },
    execute: config.execute,
    varHints: config.varHints,
    tags: config.tags
  };
}
function isTool(obj) {
  return typeof obj === "object" && obj !== null && "meta" in obj && "execute" in obj && typeof obj.execute === "function";
}

// runtime/plugins/index.ts
var plugins_exports = {};
__export(plugins_exports, {
  context: () => context,
  hitl: () => hitl,
  logger: () => logger,
  planning: () => planning,
  subagentReporter: () => subagentReporter,
  subagents: () => subagents,
  vars: () => vars
});

// runtime/plugins/vars.ts
var VAR_PATTERN = /\$([A-Z][A-Z0-9_]*)/g;
function resolveVars(value, vars2) {
  if (typeof value === "string") {
    const fullMatch = value.match(/^\$([A-Z][A-Z0-9_]*)$/);
    if (fullMatch) {
      const varName = fullMatch[1];
      return varName in vars2 ? vars2[varName] : value;
    }
    return value.replace(VAR_PATTERN, (match, varName) => {
      if (varName in vars2) {
        const resolved = vars2[varName];
        return typeof resolved === "string" ? resolved : String(resolved);
      }
      return match;
    });
  }
  if (Array.isArray(value)) {
    return value.map((v) => resolveVars(v, vars2));
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, resolveVars(v, vars2)])
    );
  }
  return value;
}
var vars = {
  name: "vars",
  async onToolStart(ctx, call) {
    const agentVars = ctx.agent.vars;
    call.args = resolveVars(call.args, agentVars);
  },
  tags: ["default"]
};

// runtime/plugins/logger.ts
var logger = {
  name: "logger",
  async onEvent(ctx, event) {
    console.log(
      `[${event.type.toUpperCase()} | ${ctx.agent.info.threadId.slice(0, 8)}]:
${JSON.stringify(event, null, 2)}

`
    );
  },
  tags: ["logs"]
};

// runtime/plugins/hitl.ts
var HitlEventType = {
  RESUME: "hitl.resume"
};
var hitl = {
  name: "hitl",
  varHints: [
    {
      name: "HITL_TOOLS",
      description: "Array of tool names that require human approval"
    }
  ],
  actions: {
    async approve(ctx, payload) {
      const { approved, modifiedToolCalls } = payload;
      const runState = ctx.agent.runState;
      const pending = ctx.agent.info.pendingToolCalls ?? [];
      if (!pending.length) {
        throw new Error("no pending tool calls");
      }
      const decided = modifiedToolCalls ?? pending;
      ctx.agent.info.pendingToolCalls = decided;
      runState.status = "running";
      runState.reason = void 0;
      ctx.agent.emit(HitlEventType.RESUME, {
        approved,
        modifiedToolCalls: decided
      });
      ctx.agent.emit("gen_ai.agent.resumed" /* AGENT_RESUMED */, {});
      await ctx.agent.ensureScheduled();
      return { ok: true };
    }
  },
  async onModelResult(ctx, res) {
    const runState = ctx.agent.runState;
    const last = res.message;
    const calls = last?.role === "assistant" && "toolCalls" in last ? last.toolCalls ?? [] : [];
    const watchTools = ctx.agent.vars.HITL_TOOLS;
    const risky = calls.find((c) => watchTools?.includes(c.name));
    if (risky) {
      runState.status = "paused";
      runState.reason = "hitl";
      ctx.agent.emit("gen_ai.agent.paused" /* AGENT_PAUSED */, {
        reason: "hitl"
      });
    }
  },
  tags: ["hitl"]
};
var WRITE_TODOS_TOOL_DESCRIPTION = `Use this tool to create and manage a structured task list for your current work session. This helps you track progress, organize complex tasks, and demonstrate thoroughness to the user.
It also helps the user understand the progress of the task and overall progress of their requests.
Only use this tool if you think it will be helpful in staying organized. If the user's request is trivial and takes less than 3 steps, it is better to NOT use this tool and just do the task directly.

## When to Use This Tool
Use this tool in these scenarios:

1. Complex multi-step tasks - When a task requires 3 or more distinct steps or actions
2. Non-trivial and complex tasks - Tasks that require careful planning or multiple operations
3. User explicitly requests todo list - When the user directly asks you to use the todo list
4. User provides multiple tasks - When users provide a list of things to be done (numbered or comma-separated)
5. The plan may need future revisions or updates based on results from the first few steps

## How to Use This Tool
1. When you start working on a task - Mark it as in_progress BEFORE beginning work.
2. After completing a task - Mark it as completed and add any new follow-up tasks discovered during implementation.
3. You can also update future tasks, such as deleting them if they are no longer necessary, or adding new tasks that are necessary.
4. You can make several updates to the todo list at once.

## When NOT to Use This Tool
Skip using this tool when:
1. There is only a single, straightforward task
2. The task is trivial and tracking it provides no benefit
3. The task can be completed in less than 3 trivial steps
4. The task is purely conversational or informational

## Task States
- pending: Task not yet started
- in_progress: Currently working on
- completed: Task finished successfully

Being proactive with task management demonstrates attentiveness and ensures you complete all requirements successfully.
`;
var WRITE_TODOS_SYSTEM_PROMPT = `## \`write_todos\`

You have access to the \`write_todos\` tool to help you manage and plan complex objectives.
Use this tool for complex objectives to ensure that you are tracking each necessary step and giving the user visibility into your progress.

It is critical that you mark todos as completed as soon as you are done with a step. Do not batch up multiple steps before marking them as completed.
For simple objectives that only require a few steps, it is better to just complete the objective directly and NOT use this tool.

## Important Notes
- The \`write_todos\` tool should never be called multiple times in parallel.
- Don't be afraid to revise the list as you go. New information may reveal new tasks or make old tasks irrelevant.`;
var write_todos = tool({
  name: "write_todos",
  description: WRITE_TODOS_TOOL_DESCRIPTION,
  inputSchema: z.object({
    todos: z.array(
      z.object({
        content: z.string().describe("Task text"),
        status: z.enum(["pending", "in_progress", "completed"]).describe("Current task state")
      })
    ).describe("Full replacement list of todos")
  }),
  execute: async (p, ctx) => {
    const sql = ctx.agent.sqlite;
    const clean = (p.todos ?? []).map((t) => ({
      content: String(t.content ?? "").slice(0, 2e3),
      status: t.status === "in_progress" || t.status === "completed" ? t.status : "pending"
    }));
    sql`DELETE FROM todos`;
    let pos = 0;
    for (const td of clean) {
      sql`INSERT INTO todos (content, status, pos, updated_at) VALUES (${td.content}, ${td.status}, ${pos++}, ${Date.now()})`;
    }
    return `Updated todo list (${clean.length} items).`;
  }
});
var planning = {
  name: "planning",
  async onInit(ctx) {
    ctx.agent.sqlite`
CREATE TABLE IF NOT EXISTS todos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  content TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending','in_progress','completed')),
  pos INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);
`;
  },
  state: (ctx) => {
    const rows = ctx.agent.sqlite`
      SELECT content, status FROM todos ORDER BY pos ASC, id ASC
    `;
    const todos = [];
    for (const r of rows) {
      todos.push({
        content: String(r.content ?? ""),
        status: String(r.status)
      });
    }
    return { todos };
  },
  async beforeModel(ctx, plan) {
    plan.addSystemPrompt(WRITE_TODOS_SYSTEM_PROMPT);
    ctx.registerTool(write_todos);
  },
  tags: ["default"]
};

// runtime/plugins/context.ts
var SUMMARIZATION_SYSTEM_PROMPT = `You are summarizing a conversation to preserve context while reducing length.

Create a concise summary that captures:
- Key decisions made
- Important information learned about the user or task
- Tasks completed and their outcomes
- Pending items or ongoing context

If there are important facts worth remembering long-term (user preferences, names, key facts learned), output them in a special section:

<memories>
- User's name is John
- User prefers concise responses
- Project deadline is January 15th
</memories>

Keep the summary focused and actionable. The agent will continue the conversation with only this summary as history.
Do NOT include the <memories> section if there are no new facts worth remembering.`;
function buildSummaryPrompt(previousSummary, messages) {
  let prompt = "";
  if (previousSummary) {
    prompt += `Previous conversation summary:
${previousSummary}

---

`;
    prompt += "New messages to incorporate into the summary:\n\n";
  } else {
    prompt += "Messages to summarize:\n\n";
  }
  for (const msg of messages) {
    const role = msg.role.toUpperCase();
    let content;
    if ("content" in msg && typeof msg.content === "string") {
      content = msg.content;
    } else if ("toolCalls" in msg && msg.toolCalls) {
      content = `[Tool calls: ${msg.toolCalls.map((tc) => tc.name).join(", ")}]`;
    } else {
      content = "[No content]";
    }
    if (content.length > 500) {
      content = content.slice(0, 500) + "... [truncated]";
    }
    prompt += `[${role}]: ${content}

`;
  }
  prompt += "---\n\n";
  prompt += "Provide an updated summary that incorporates all the above. ";
  prompt += "Be concise but preserve important context.";
  return prompt;
}
function parseSummaryResponse(content) {
  const memoriesMatch = content.match(/<memories>([\s\S]*?)<\/memories>/i);
  let memories = [];
  let summary = content;
  if (memoriesMatch) {
    summary = content.replace(/<memories>[\s\S]*?<\/memories>/i, "").trim();
    memories = memoriesMatch[1].split("\n").map((line) => line.replace(/^[-*]\s*/, "").trim()).filter((line) => line.length > 0);
  }
  return { summary, memories };
}
async function archiveMessages(fs, messages, startSeq, endSeq, agentId) {
  const timestamp = (/* @__PURE__ */ new Date()).toISOString().replace(/[:.]/g, "-");
  const path = `~/logs/archive-${timestamp}.json`;
  const archive = {
    archivedAt: (/* @__PURE__ */ new Date()).toISOString(),
    agentId,
    sequenceRange: { start: startSeq, end: endSeq },
    messageCount: messages.length,
    messages
  };
  await fs.writeFile(path, JSON.stringify(archive, null, 2));
  return path;
}
async function storeMemories(fs, diskName, memories) {
  const path = `/shared/memories/${diskName}.idz`;
  let idz = null;
  try {
    const content = await fs.readFile(path);
    idz = content ? JSON.parse(content) : null;
  } catch {
    idz = null;
  }
  if (!idz) {
    idz = {
      version: 1,
      name: diskName,
      description: "Memories extracted from conversation summaries",
      hasEmbeddings: false,
      entries: []
    };
  }
  const now = (/* @__PURE__ */ new Date()).toISOString();
  for (const memory of memories) {
    idz.entries.push({
      content: memory,
      extra: {
        source: "context-summary",
        extractedAt: now
      }
    });
  }
  idz.hasEmbeddings = false;
  await fs.writeFile(path, JSON.stringify(idz));
}
var context = {
  name: "context",
  tags: ["context"],
  varHints: [
    {
      name: "CONTEXT_KEEP_RECENT",
      required: false,
      description: `Messages to keep in full (default: ${DEFAULT_CONTEXT_KEEP_RECENT})`
    },
    {
      name: "CONTEXT_SUMMARIZE_AT",
      required: false,
      description: `Summarize when message count exceeds this (default: ${DEFAULT_CONTEXT_SUMMARIZE_AT})`
    },
    {
      name: "CONTEXT_MEMORY_DISK",
      required: false,
      description: "Disk name to store extracted memories (optional)"
    },
    {
      name: "CONTEXT_SUMMARY_MODEL",
      required: false,
      description: "Model for summarization (uses agent's model by default)"
    }
  ],
  state(ctx) {
    const checkpoint = ctx.agent.store.getLatestCheckpoint();
    return {
      hasCheckpoint: !!checkpoint,
      checkpointCount: ctx.agent.store.getCheckpointCount(),
      lastSummaryAt: checkpoint?.createdAt ? new Date(checkpoint.createdAt).toISOString() : null
    };
  },
  async beforeModel(ctx, plan) {
    const KEEP_RECENT = ctx.agent.vars.CONTEXT_KEEP_RECENT ?? DEFAULT_CONTEXT_KEEP_RECENT;
    const SUMMARIZE_AT = ctx.agent.vars.CONTEXT_SUMMARIZE_AT ?? DEFAULT_CONTEXT_SUMMARIZE_AT;
    const MEMORY_DISK = ctx.agent.vars.CONTEXT_MEMORY_DISK;
    const SUMMARY_MODEL = ctx.agent.vars.CONTEXT_SUMMARY_MODEL;
    const store = ctx.agent.store;
    const checkpoint = store.getLatestCheckpoint();
    const totalMessages = store.getMessageCount();
    const checkpointEndSeq = checkpoint?.messagesEndSeq ?? 0;
    const messagesAfterCheckpoint = checkpoint ? store.getMessagesAfter(checkpointEndSeq).length : totalMessages;
    if (messagesAfterCheckpoint <= SUMMARIZE_AT) {
      if (checkpoint) {
        const recentMessages = store.getMessagesAfter(checkpointEndSeq);
        plan.setMessages([
          {
            role: "user",
            content: `[Previous Conversation Summary]
${checkpoint.summary}

---
Continue from where we left off.`
          },
          ...recentMessages.filter((m) => m.role !== "system")
        ]);
      }
      return;
    }
    const fs = ctx.agent.fs;
    const allMessages = checkpoint ? store.getMessagesAfter(checkpointEndSeq) : store.getContext(1e3);
    if (allMessages.length <= KEEP_RECENT) {
      return;
    }
    const toSummarize = allMessages.slice(0, -KEEP_RECENT);
    const toKeep = allMessages.slice(-KEEP_RECENT);
    const summaryPrompt = buildSummaryPrompt(checkpoint?.summary, toSummarize);
    ctx.agent.emit("context.summarizing", {
      messageCount: toSummarize.length,
      keepingRecent: toKeep.length
    });
    const SUMMARIZATION_TIMEOUT_MS = 6e4;
    let summaryResult;
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), SUMMARIZATION_TIMEOUT_MS);
      try {
        summaryResult = await ctx.agent.provider.invoke(
          {
            model: SUMMARY_MODEL ?? ctx.agent.model,
            systemPrompt: SUMMARIZATION_SYSTEM_PROMPT,
            messages: [{ role: "user", content: summaryPrompt }],
            toolDefs: []
          },
          { signal: controller.signal }
        );
      } finally {
        clearTimeout(timeout);
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      ctx.agent.emit("context.error", {
        phase: "summarization",
        error: errorMsg
      });
      console.error("context: Summarization failed:", errorMsg);
      return;
    }
    const msg = summaryResult.message;
    let responseContent;
    if ("content" in msg && typeof msg.content === "string") {
      responseContent = msg.content;
    } else {
      responseContent = "[No content in summarization response]";
    }
    const { summary, memories } = parseSummaryResponse(responseContent);
    if (MEMORY_DISK && memories.length > 0) {
      try {
        await storeMemories(fs, MEMORY_DISK, memories);
      } catch (err) {
        console.warn("context: Failed to store memories:", err);
      }
    }
    const maxSeq = store.getMaxMessageSeq();
    const startSeq = checkpointEndSeq + 1;
    const endSeq = maxSeq - KEEP_RECENT;
    let archivePath;
    try {
      archivePath = await archiveMessages(
        fs,
        toSummarize,
        startSeq,
        endSeq,
        ctx.agent.info.threadId || "unknown"
      );
    } catch (err) {
      console.warn("context: Failed to archive messages:", err);
    }
    store.addCheckpoint(summary, startSeq, endSeq, archivePath);
    const deleted = store.deleteMessagesBefore(endSeq);
    ctx.agent.emit("context.summarized", {
      messagesSummarized: toSummarize.length,
      messagesDeleted: deleted,
      memoriesExtracted: memories.length,
      archivedTo: archivePath,
      summaryLength: summary.length
    });
    plan.setMessages([
      {
        role: "user",
        content: `[Previous Conversation Summary]
${summary}

---
Continue from where we left off.`
      },
      ...toKeep.filter((m) => m.role !== "system")
    ]);
  }
};
var SubagentEventType = {
  SPAWNED: "subagent.spawned",
  COMPLETED: "subagent.completed",
  MESSAGED: "subagent.messaged"
};
var TaskParams = z.object({
  description: z.string().describe("Task description for the subagent"),
  subagentType: z.string().describe("Type of subagent to spawn")
});
var MessageAgentParams = z.object({
  agentId: z.string().describe("The agentId from a previous task result"),
  message: z.string().describe("Follow-up message to send to the agent")
});
function renderOtherAgents(subagents2) {
  return subagents2.map((a) => `- ${a.name}: ${a.description}`).join("\n");
}
var subagents = {
  name: "subagents",
  async onInit(ctx) {
    ctx.agent.sqlite`
      CREATE TABLE IF NOT EXISTS mw_waiting_subagents (
        token TEXT PRIMARY KEY,
        child_thread_id TEXT NOT NULL,
        tool_call_id TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS mw_subagent_links (
        child_thread_id TEXT PRIMARY KEY,
        token TEXT NOT NULL,
        agent_type TEXT,
        status TEXT NOT NULL CHECK(status IN ('waiting','completed','canceled')),
        created_at INTEGER NOT NULL,
        completed_at INTEGER,
        report TEXT,
        tool_call_id TEXT
      );
    `;
  },
  actions: {
    async subagent_result(ctx, payload) {
      const { token, childThreadId, report } = payload;
      const sql = ctx.agent.sqlite;
      const rows = sql`SELECT tool_call_id FROM mw_waiting_subagents WHERE token = ${token} AND child_thread_id = ${childThreadId}`;
      if (!rows.length) {
        throw new Error("unknown token");
      }
      const toolCallId = String(rows[0].tool_call_id);
      sql`DELETE FROM mw_waiting_subagents WHERE token = ${token}`;
      sql`UPDATE mw_subagent_links SET status='completed', completed_at=${Date.now()}, report=${report ?? null} WHERE child_thread_id = ${childThreadId}`;
      const result = JSON.stringify({
        agentId: childThreadId,
        result: report ?? ""
      });
      ctx.agent.store.add({ role: "tool", toolCallId, content: result });
      ctx.agent.emit(SubagentEventType.COMPLETED, {
        childThreadId,
        result: report
      });
      const remaining = sql`SELECT COUNT(*) as c FROM mw_waiting_subagents`;
      if (Number(remaining[0]?.c ?? 0) === 0) {
        ctx.agent.runState.status = "running";
        ctx.agent.runState.reason = void 0;
        ctx.agent.emit("gen_ai.agent.resumed" /* AGENT_RESUMED */, {});
        await ctx.agent.ensureScheduled();
      }
      return { ok: true };
    },
    async cancel_subagents(ctx) {
      const sql = ctx.agent.sqlite;
      const waiters = sql`SELECT token, child_thread_id FROM mw_waiting_subagents`;
      for (const w of waiters) {
        try {
          const childAgent = await getAgentByName(
            ctx.agent.exports.HubAgent,
            String(w.child_thread_id)
          );
          await childAgent.fetch(
            new Request("http://do/action", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ type: "cancel" })
            })
          );
        } catch (e) {
          console.error(`Failed to cancel subagent ${w.child_thread_id}:`, e);
        }
        sql`UPDATE mw_subagent_links SET status='canceled', completed_at=${Date.now()} WHERE child_thread_id = ${w.child_thread_id}`;
      }
      sql`DELETE FROM mw_waiting_subagents`;
      return { ok: true };
    }
  },
  state(ctx) {
    const sql = ctx.agent.sqlite;
    const rows = sql`SELECT child_thread_id, token, agent_type, status, created_at, completed_at, report, tool_call_id
         FROM mw_subagent_links ORDER BY created_at ASC`;
    const subagents2 = rows.map((r) => ({
      childThreadId: String(r.child_thread_id),
      token: String(r.token ?? ""),
      agentType: r.agent_type ? String(r.agent_type) : void 0,
      status: String(r.status),
      createdAt: Number(r.created_at ?? Date.now()),
      completedAt: r.completed_at ? Number(r.completed_at) : void 0,
      report: r.report ? String(r.report) : void 0,
      toolCallId: r.tool_call_id ? String(r.tool_call_id) : void 0
    }));
    return { subagents: subagents2 };
  },
  async beforeModel(ctx, plan) {
    plan.addSystemPrompt(TASK_SYSTEM_PROMPT);
    const subagentsConfig = ctx.agent.vars.SUBAGENTS;
    const otherAgents = renderOtherAgents(subagentsConfig ?? []);
    const taskDesc = TASK_TOOL_DESCRIPTION.replace(
      "{other_agents}",
      otherAgents
    );
    const taskTool = tool({
      name: "task",
      description: taskDesc,
      inputSchema: TaskParams,
      execute: async (p, toolCtx) => {
        const { description, subagentType } = p;
        const token = crypto.randomUUID();
        const sql = ctx.agent.sqlite;
        const parentAgentId = ctx.agent.info.threadId;
        const vars2 = toolCtx.agent.vars;
        const agency = await getAgentByName(
          toolCtx.agent.exports.Agency,
          ctx.agent.info.agencyId
        );
        const spawnRes = await agency.fetch(
          new Request("http://do/agents", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              agentType: subagentType,
              requestContext: ctx.agent.info.request,
              relatedAgentId: parentAgentId
            })
          })
        );
        if (!spawnRes.ok) {
          return "Error: Failed to spawn subagent";
        }
        const spawnData = await spawnRes.json();
        const childId = spawnData.id;
        const subagent = await getAgentByName(
          toolCtx.agent.exports.HubAgent,
          childId
        );
        const invokeRes = await subagent.fetch(
          new Request("http://do/invoke", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              messages: [{ role: "user", content: String(description ?? "") }],
              vars: {
                ...vars2,
                parent: {
                  threadId: parentAgentId,
                  token
                }
              }
            })
          })
        );
        if (!invokeRes.ok) {
          return "Error: Failed to invoke subagent";
        }
        ctx.agent.emit(SubagentEventType.SPAWNED, {
          childThreadId: childId,
          agentType: subagentType,
          toolCallId: toolCtx.callId
        });
        sql`INSERT INTO mw_waiting_subagents (token, child_thread_id, tool_call_id, created_at)
           VALUES (${token}, ${childId}, ${toolCtx.callId}, ${Date.now()})`;
        sql`INSERT INTO mw_subagent_links (child_thread_id, token, agent_type, status, created_at, tool_call_id)
           VALUES (${childId}, ${token}, ${subagentType}, 'waiting', ${Date.now()}, ${toolCtx.callId})`;
        const runState = ctx.agent.runState;
        if (runState && runState.status === "running") {
          runState.status = "paused";
          runState.reason = "subagent";
          ctx.agent.emit("gen_ai.agent.paused" /* AGENT_PAUSED */, {
            reason: "subagent"
          });
        }
        return null;
      }
    });
    ctx.registerTool(taskTool);
    const messageAgentTool = tool({
      name: "message_agent",
      description: `Send a follow-up message to a subagent you previously spawned via the task tool.
Use this when you need to continue a conversation with a specific agent that already has context from prior interactions.
The agentId is returned in the result object of the task tool (e.g., {"agentId": "...", "result": "..."}).`,
      inputSchema: MessageAgentParams,
      execute: async ({ agentId, message }, toolCtx) => {
        const sql = ctx.agent.sqlite;
        const link = sql`SELECT status, agent_type FROM mw_subagent_links WHERE child_thread_id = ${agentId}`;
        if (!link.length) {
          return "Error: Unknown agent ID. Make sure this is an agentId from a previous task result.";
        }
        const token = crypto.randomUUID();
        sql`INSERT INTO mw_waiting_subagents (token, child_thread_id, tool_call_id, created_at)
           VALUES (${token}, ${agentId}, ${toolCtx.callId}, ${Date.now()})`;
        sql`UPDATE mw_subagent_links 
           SET status = 'waiting', token = ${token}, tool_call_id = ${toolCtx.callId}
           WHERE child_thread_id = ${agentId}`;
        const agent = await getAgentByName(
          toolCtx.agent.exports.HubAgent,
          agentId
        );
        ctx.agent.emit(SubagentEventType.MESSAGED, {
          childThreadId: agentId,
          message
        });
        const res = await agent.fetch(
          new Request("http://do/invoke", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              messages: [{ role: "user", content: message }],
              vars: {
                parent: {
                  threadId: ctx.agent.info.threadId,
                  token
                }
              }
            })
          })
        );
        if (!res.ok) {
          return "Error: Failed to message agent";
        }
        const runState = ctx.agent.runState;
        if (runState && runState.status === "running") {
          runState.status = "paused";
          runState.reason = "subagent";
          ctx.agent.emit("gen_ai.agent.paused" /* AGENT_PAUSED */, { reason: "subagent" });
        }
        return null;
      }
    });
    ctx.registerTool(messageAgentTool);
  },
  tags: ["subagents", "default"]
};
var TASK_SYSTEM_PROMPT = `## \`task\` (subagent spawner)

You have access to a \`task\` tool to launch short-lived subagents that handle isolated tasks. These agents are ephemeral \u2014 they live only for the duration of the task and return a single result.

When to use the task tool:
- When a task is complex and multi-step, and can be fully delegated in isolation
- When a task is independent of other tasks and can run in parallel
- When a task requires focused reasoning or heavy token/context usage that would bloat the orchestrator thread
- When sandboxing improves reliability (e.g. code execution, structured searches, data formatting)
- When you only care about the output of the subagent, and not the intermediate steps (ex. performing a lot of research and then returned a synthesized report, performing a series of computations or lookups to achieve a concise, relevant answer.)

Subagent lifecycle:
1. **Spawn** \u2192 Provide clear role, instructions, and expected output
2. **Run** \u2192 The subagent completes the task autonomously
3. **Return** \u2192 The subagent provides a single structured result
4. **Reconcile** \u2192 Incorporate or synthesize the result into the main thread

When NOT to use the task tool:
- If you need to see the intermediate reasoning or steps after the subagent has completed (the task tool hides them)
- If the task is trivial (a few tool calls or simple lookup)
- If delegating does not reduce token usage, complexity, or context switching
- If splitting would add latency without benefit

## Important Task Tool Usage Notes to Remember
- Whenever possible, parallelize the work that you do. This is true for both tool calls, and for tasks. Whenever you have independent steps to complete - make tool calls, or kick off tasks (subagents) in parallel to accomplish them faster. This saves time for the user, which is incredibly important.
- Remember to use the \`task\` tool to silo independent tasks within a multi-part objective.
- You should use the \`task\` tool whenever you have a complex task that will take multiple steps, and is independent from other tasks that the agent needs to complete. These agents are highly competent and efficient.`;
var TASK_TOOL_DESCRIPTION = `Launch an ephemeral subagent to handle complex, multi-step independent tasks with isolated context windows. 

Available agent types and the tools they have access to:
{other_agents}

When using the Task tool, you must specify a subagentType parameter to select which agent type to use.

## Usage notes:
1. Launch multiple agents concurrently whenever possible, to maximize performance; to do that, use a single message with multiple tool uses
2. When the agent is done, it will return a single message back to you. The result returned by the agent is not visible to the user. To show the user the result, you should send a text message back to the user with a concise summary of the result.
3. Each task result includes an agentId that you can use with message_agent to send follow-up messages to the same agent. Therefore, your prompt should contain a highly detailed task description for the agent to perform autonomously and you should specify exactly what information the agent should return back to you in its final and only message to you.
4. The agent's outputs should generally be trusted
5. Clearly tell the agent whether you expect it to create content, perform analysis, or just do research (search, file reads, web fetches, etc.), since it is not aware of the user's intent
6. If the agent description mentions that it should be used proactively, then you should try your best to use it without the user having to ask for it first. Use your judgement.
7. When only the general-purpose agent is provided, you should use it for all tasks. It is great for isolating context and token usage, and completing specific, complex tasks, as it has all the same capabilities as the main agent.

### Example usage of the general-purpose agent:

<example_agent_descriptions>
"general-purpose": use this agent for general purpose tasks, it has access to all tools as the main agent.
</example_agent_descriptions>

<example>
User: "I want to conduct research on the accomplishments of Lebron James, Michael Jordan, and Kobe Bryant, and then compare them."
Assistant: *Uses the task tool in parallel to conduct isolated research on each of the three players*
Assistant: *Synthesizes the results of the three isolated research tasks and responds to the User*
<commentary>
Research is a complex, multi-step task in it of itself.
The research of each individual player is not dependent on the research of the other players.
The assistant uses the task tool to break down the complex objective into three isolated tasks.
Each research task only needs to worry about context and tokens about one player, then returns synthesized information about each player as the Tool Result.
This means each research task can dive deep and spend tokens and context deeply researching each player, but the final result is synthesized information, and saves us tokens in the long run when comparing the players to each other.
</commentary>
</example>

<example>
User: "Analyze a single large code repository for security vulnerabilities and generate a report."
Assistant: *Launches a single \`task\` subagent for the repository analysis*
Assistant: *Receives report and integrates results into final summary*
<commentary>
Subagent is used to isolate a large, context-heavy task, even though there is only one. This prevents the main thread from being overloaded with details.
If the user then asks followup questions, we have a concise report to reference instead of the entire history of analysis and tool calls, which is good and saves us time and money.
</commentary>
</example>

<example>
User: "Schedule two meetings for me and prepare agendas for each."
Assistant: *Calls the task tool in parallel to launch two \`task\` subagents (one per meeting) to prepare agendas*
Assistant: *Returns final schedules and agendas*
<commentary>
Tasks are simple individually, but subagents help silo agenda preparation.
Each subagent only needs to worry about the agenda for one meeting.
</commentary>
</example>

<example>
User: "I want to order a pizza from Dominos, order a burger from McDonald's, and order a salad from Subway."
Assistant: *Calls tools directly in parallel to order a pizza from Dominos, a burger from McDonald's, and a salad from Subway*
<commentary>
The assistant did not use the task tool because the objective is super simple and clear and only requires a few trivial tool calls.
It is better to just complete the task directly and NOT use the \`task\`tool.
</commentary>
</example>

### Example usage with custom agents:

<example_agent_descriptions>
"content-reviewer": use this agent after you are done creating significant content or documents
"greeting-responder": use this agent when to respond to user greetings with a friendly joke
"research-analyst": use this agent to conduct thorough research on complex topics
</example_agent_description>

<example>
user: "Please write a function that checks if a number is prime"
assistant: Sure let me write a function that checks if a number is prime
assistant: First let me use the Write tool to write a function that checks if a number is prime
assistant: I'm going to use the Write tool to write the following code:
<code>
function isPrime(n) {{
  if (n <= 1) return false
  for (let i = 2; i * i <= n; i++) {{
    if (n % i === 0) return false
  }}
  return true
}}
</code>
<commentary>
Since significant content was created and the task was completed, now use the content-reviewer agent to review the work
</commentary>
assistant: Now let me use the content-reviewer agent to review the code
assistant: Uses the Task tool to launch with the content-reviewer agent 
</example>

<example>
user: "Can you help me research the environmental impact of different renewable energy sources and create a comprehensive report?"
<commentary>
This is a complex research task that would benefit from using the research-analyst agent to conduct thorough analysis
</commentary>
assistant: I'll help you research the environmental impact of renewable energy sources. Let me use the research-analyst agent to conduct comprehensive research on this topic.
assistant: Uses the Task tool to launch with the research-analyst agent, providing detailed instructions about what research to conduct and what format the report should take
</example>

<example>
user: "Hello"
<commentary>
Since the user is greeting, use the greeting-responder agent to respond with a friendly joke
</commentary>
assistant: "I'm going to use the Task tool to launch with the greeting-responder agent"
</example>`;
var subagentReporter = {
  name: "subagent_reporter",
  async onRunComplete(ctx, { final }) {
    const parent = ctx.agent.vars.parent;
    if (!parent?.threadId || !parent?.token) {
      return;
    }
    try {
      const parentAgent = await getAgentByName(
        ctx.agent.exports.HubAgent,
        parent.threadId
      );
      const actionType = parent.action ?? "subagent_result";
      await parentAgent.fetch(
        new Request("http://do/action", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            type: actionType,
            token: parent.token,
            childThreadId: ctx.agent.info.threadId,
            report: final
          })
        })
      );
    } catch (e) {
      console.error("Failed to report to parent:", e);
    }
  },
  tags: ["subagent_reporter"]
};

export { AgentEventType, AgentFileSystem, AgentHub, DEFAULT_CONTEXT_KEEP_RECENT, DEFAULT_CONTEXT_MEMORY_DISK, DEFAULT_CONTEXT_SUMMARIZE_AT, DEFAULT_CONTEXT_SUMMARY_MODEL, DEFAULT_LLM_API_BASE, DEFAULT_LLM_RETRY_BACKOFF_MS, DEFAULT_LLM_RETRY_JITTER_RATIO, DEFAULT_LLM_RETRY_MAX, DEFAULT_LLM_RETRY_MAX_BACKOFF_MS, DEFAULT_LLM_RETRY_STATUS_CODES, DEFAULT_MAX_ITERATIONS, HubAgent, LegacyEventTypeMap, MAX_TOOLS_PER_TICK, TestProvider, VAR_DEFAULT_MODEL, VAR_LLM_API_BASE, VAR_LLM_API_KEY, VAR_LLM_RETRY_BACKOFF_MS, VAR_LLM_RETRY_JITTER_RATIO, VAR_LLM_RETRY_MAX, VAR_LLM_RETRY_MAX_BACKOFF_MS, VAR_LLM_RETRY_STATUS_CODES, createEchoProvider, createHandler, createTestProvider, createToolCallProvider, filterMcpToolsByCapabilities, isTool, makeChatCompletions, parseModel, plugins_exports as plugins, tool };
//# sourceMappingURL=index.js.map
//# sourceMappingURL=index.js.map