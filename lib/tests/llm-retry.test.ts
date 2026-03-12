import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeChatCompletions } from "../runtime/providers/chat-completions";

describe("LLM provider retries", () => {
  const req = {
    model: "test-model",
    messages: [{ role: "user" as const, content: "Hello" }],
  };

  function createOkResponse() {
    return new Response(
      JSON.stringify({
        choices: [{ message: { role: "assistant", content: "ok" } }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  }

  const retryOptions = {
    maxRetries: 1,
    backoffMs: 0,
    maxBackoffMs: 0,
    jitterRatio: 0,
    retryableStatusCodes: [520],
  };

  function createStreamResponse(...events: Array<Record<string, unknown> | "[DONE]">) {
    const encoder = new TextEncoder();
    const body = events
      .map((event) =>
        event === "[DONE]" ? "data: [DONE]\n\n" : `data: ${JSON.stringify(event)}\n\n`
      )
      .join("");

    return new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode(body));
          controller.close();
        },
      }),
      { status: 200, headers: { "content-type": "text/event-stream" } }
    );
  }

  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("retries when the response status is retryable", async () => {
    fetchSpy
      .mockResolvedValueOnce(
        new Response("temporary", { status: 520, headers: { "Retry-After": "0" } })
      )
      .mockResolvedValueOnce(createOkResponse());

    const provider = makeChatCompletions("test-key", "https://example.test/v1", {
      retry: retryOptions,
    });

    const result = await provider.invoke(req, {});
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    if ("content" in result.message) {
      expect(result.message.content).toBe("ok");
    }
  });

  it("does not retry when the status is not retryable", async () => {
    fetchSpy.mockResolvedValueOnce(new Response("bad", { status: 400 }));

    const provider = makeChatCompletions("test-key", "https://example.test/v1", {
      retry: retryOptions,
    });

    await expect(provider.invoke(req, {})).rejects.toThrow(
      "Chat completions error 400"
    );
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("retries when the assistant response is blank", async () => {
    fetchSpy
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            choices: [{ message: { role: "assistant", content: "" } }],
            usage: { prompt_tokens: 1, completion_tokens: 1 },
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        )
      )
      .mockResolvedValueOnce(createOkResponse());

    const provider = makeChatCompletions("test-key", "https://example.test/v1", {
      retry: retryOptions,
    });

    const result = await provider.invoke(req, {});
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    if ("content" in result.message) {
      expect(result.message.content).toBe("ok");
    }
  });

  it("retries stream responses when the assistant response is blank", async () => {
    fetchSpy
      .mockResolvedValueOnce(
        createStreamResponse(
          { choices: [{ delta: {} }] },
          { usage: { prompt_tokens: 1, completion_tokens: 0 } },
          "[DONE]"
        )
      )
      .mockResolvedValueOnce(
        createStreamResponse(
          { choices: [{ delta: { content: "ok" } }] },
          { usage: { prompt_tokens: 1, completion_tokens: 1 } },
          "[DONE]"
        )
      );

    const provider = makeChatCompletions("test-key", "https://example.test/v1", {
      retry: retryOptions,
    });

    const deltas: string[] = [];
    const result = await provider.stream(req, (delta) => {
      deltas.push(delta);
    });

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(deltas).toEqual(["ok"]);
    if ("content" in result.message) {
      expect(result.message.content).toBe("ok");
    }
  });
});
