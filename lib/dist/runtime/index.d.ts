import { P as Provider, T as ToolCall, C as ChatMessage, M as ModelResult, a as ModelRequest, A as AgentBlueprint, b as CfCtx, c as Tool, d as AgentPlugin, H as HubAgent, e as Agency, f as ToolJsonSchema, g as ToolContext } from '../types-BeVSZmUd.js';
export { h as AgencyRelayEvent, i as AgentEnv, j as AgentEvent, k as AgentEventData, l as AgentEventType, m as AgentFSContext, n as AgentFileSystem, o as AgentState, p as AnalyticsEngineDataset, q as ApproveBody, r as ChatMessageBase, s as CreateThreadRequest, t as CustomEventData, E as Exports, F as FSEntry, I as Info, u as InvokeBody, L as LegacyEventTypeMap, v as PluginContext, R as RunState, w as RunStatus, S as SubagentLink, x as SubagentLinkStatus, y as ThreadMetadata, z as ThreadRequestContext, B as ToolMeta, V as VarHint, D as parseModel } from '../types-BeVSZmUd.js';
import { R2Bucket } from '@cloudflare/workers-types';
export { i as plugins } from '../index-Db2XRLnD.js';
export { z } from 'zod';
import 'cloudflare:workers';
import 'agents';

type ChatCompletionsRetryOptions = {
    maxRetries: number;
    backoffMs: number;
    maxBackoffMs: number;
    jitterRatio: number;
    retryableStatusCodes: number[];
};
type ChatCompletionsOptions = {
    retry?: ChatCompletionsRetryOptions;
};
/**
 * Creates a provider for OpenAI-compatible chat completions APIs.
 * Works with OpenAI, OpenRouter, Azure OpenAI, and other compatible endpoints.
 */
declare function makeChatCompletions(apiKey: string, baseUrl?: string, options?: ChatCompletionsOptions): Provider;

/**
 * A response that the TestProvider should return.
 * Can be a simple text response, a tool call, or a full ChatMessage.
 */
type MockResponse = string | {
    toolCalls: ToolCall[];
} | {
    message: ChatMessage;
    usage?: ModelResult["usage"];
};
/**
 * Configuration for expected tool calls.
 * Used to validate that the agent makes the expected tool calls.
 */
interface ToolCallExpectation {
    name: string;
    args?: Record<string, unknown> | ((args: unknown) => boolean);
}
/**
 * TestProvider gives tests full control over LLM responses.
 *
 * Features:
 * - Queue responses to return in order
 * - Record all requests made to the provider
 * - Set expectations for tool calls
 * - Provide dynamic response handlers
 *
 * @example
 * ```ts
 * const provider = new TestProvider();
 *
 * // Queue simple text responses
 * provider.addResponse("Hello!");
 * provider.addResponse("How can I help?");
 *
 * // Queue a tool call
 * provider.addResponse({
 *   toolCalls: [{
 *     id: "call_1",
 *     name: "search",
 *     args: { query: "test" }
 *   }]
 * });
 *
 * // After running the agent, check requests
 * expect(provider.requests).toHaveLength(2);
 * expect(provider.requests[0].messages).toContainEqual({ role: "user", content: "Hi" });
 * ```
 */
declare class TestProvider implements Provider {
    /** All requests made to this provider */
    readonly requests: ModelRequest[];
    /** Queued responses to return */
    private responses;
    /** Dynamic response handler (used if no queued responses) */
    private responseHandler?;
    /** Tool call expectations for validation */
    private toolCallExpectations;
    /** Recorded tool calls for assertions */
    readonly toolCalls: ToolCall[];
    /**
     * Add a response to the queue.
     * Responses are returned in FIFO order.
     */
    addResponse(response: MockResponse): this;
    /**
     * Add multiple responses to the queue.
     */
    addResponses(...responses: MockResponse[]): this;
    /**
     * Set a dynamic response handler.
     * Called when the response queue is empty.
     */
    onRequest(handler: (req: ModelRequest) => MockResponse): this;
    /**
     * Set expected tool calls for validation.
     * Call `assertExpectations()` to verify they were made.
     */
    expectToolCalls(...expectations: ToolCallExpectation[]): this;
    /**
     * Assert that all expected tool calls were made.
     * Throws if expectations weren't met.
     */
    assertExpectations(): void;
    /**
     * Reset the provider state.
     * Clears requests, responses, and expectations.
     */
    reset(): this;
    /**
     * Get the next response from the queue or handler.
     */
    private getNextResponse;
    /**
     * Convert a MockResponse to a ModelResult.
     */
    private toResult;
    invoke(req: ModelRequest, _opts: {
        signal?: AbortSignal;
    }): Promise<ModelResult>;
    stream(req: ModelRequest, onDelta: (chunk: string) => void): Promise<ModelResult>;
}
/**
 * Create a simple test provider with predefined responses.
 *
 * @example
 * ```ts
 * const provider = createTestProvider("Hello!", "How can I help?");
 * ```
 */
declare function createTestProvider(...responses: MockResponse[]): TestProvider;
/**
 * Create a test provider that echoes user messages.
 * Useful for simple interaction tests.
 */
declare function createEchoProvider(): TestProvider;
/**
 * Create a test provider that always calls a specific tool.
 *
 * @example
 * ```ts
 * const provider = createToolCallProvider("search", { query: "test" });
 * ```
 */
declare function createToolCallProvider(toolName: string, args?: unknown, callId?: string): TestProvider;

type PluginInfo = {
    name: string;
    tags: string[];
    varHints?: Array<{
        name: string;
        required?: boolean;
        description?: string;
    }>;
};
type ToolInfo = {
    name: string;
    description?: string;
    tags: string[];
    varHints?: Array<{
        name: string;
        required?: boolean;
        description?: string;
    }>;
};
type HandlerOptions = {
    baseUrl?: string;
    agentDefinitions?: AgentBlueprint[];
    plugins?: PluginInfo[];
    tools?: ToolInfo[];
};
type HandlerEnv = {
    FS: R2Bucket;
};
declare const createHandler: (opts?: HandlerOptions) => {
    fetch(req: Request, env: HandlerEnv, ctx: CfCtx): Promise<Response>;
};

interface McpToolInfo {
    serverId: string;
    serverName: string;
    name: string;
    description?: string;
    inputSchema?: Record<string, unknown>;
}
/**
 * Filter MCP tools based on capability patterns.
 * Patterns:
 *   - "mcp:*" → all MCP tools from all servers
 *   - "mcp:server" → all tools from a specific server (by ID or name)
 *   - "mcp:server:toolname" → specific tool from a server (by ID or name)
 */
declare function filterMcpToolsByCapabilities(tools: McpToolInfo[], capabilities: string[]): McpToolInfo[];
type AgentHubOptions = {
    defaultModel?: string;
    provider?: Provider;
};
declare class ToolRegistry {
    private tools;
    private tags;
    private toolTags;
    addTool<T>(name: string, tool: Tool<T>, tags?: string[]): void;
    getAll(): Array<{
        name: string;
        description?: string;
        tags: string[];
        varHints?: Tool<any>["varHints"];
    }>;
    selectByCapabilities(capabilities: string[]): Tool<any>[];
}
declare class PluginRegistry {
    private plugins;
    private tags;
    addPlugin(name: string, handler: AgentPlugin, tags?: string[]): void;
    getAll(): Array<{
        name: string;
        tags: string[];
        varHints?: AgentPlugin["varHints"];
    }>;
    selectByCapabilities(capabilities: string[]): AgentPlugin[];
}
/**
 * Main entry point for configuring an AgentHub instance.
 * Register tools, plugins, and agent blueprints, then call `export()` to
 * get the Durable Object classes and HTTP handler for your Worker.
 *
 * @example
 * ```ts
 * const hub = new AgentHub({ defaultModel: "gpt-4o" })
 *   .addTool(myTool, ["@default"])
 *   .use(myPlugin)
 *   .addAgent({ name: "assistant", ... });
 *
 * export const { HubAgent, Agency, handler } = hub.export();
 * export default { fetch: handler };
 * ```
 */
declare class AgentHub {
    private options;
    toolRegistry: ToolRegistry;
    pluginRegistry: PluginRegistry;
    agentRegistry: Map<string, AgentBlueprint>;
    defaultVars: Record<string, unknown>;
    constructor(options: AgentHubOptions);
    /** Register a tool with optional tags for capability-based selection. */
    addTool<T>(tool: Tool<T>, tags?: string[]): AgentHub;
    /** Register a plugin with optional additional tags. */
    use(plugin: AgentPlugin, tags?: string[]): AgentHub;
    /** Register a static agent blueprint. */
    addAgent(blueprint: AgentBlueprint): AgentHub;
    /** Export the configured Durable Object classes and HTTP handler. */
    export(): {
        HubAgent: typeof HubAgent<AgentEnv>;
        Agency: typeof Agency;
        handler: ReturnType<typeof createHandler>;
    };
}

type ToolResult = string | object | null;
/** Structural type for Zod schemas (works with both v3 and v4) */
interface ZodSchema<T = unknown> {
    _def: unknown;
    parse: (data: unknown) => T;
}
/**
 * Define a tool with Zod or JSON Schema input.
 *
 * @example
 * ```ts
 * const read_file = tool({
 *   name: 'read_file',
 *   description: 'Read a file from the filesystem',
 *   inputSchema: z.object({
 *     path: z.string().describe('File path to read'),
 *   }),
 *   execute: async ({ path }, ctx) => {
 *     const content = await ctx.agent.fs.readFile(path);
 *     return content ?? `Error: File '${path}' not found`;
 *   },
 * });
 * ```
 */
declare function tool<TSchema extends ZodSchema | ToolJsonSchema>(config: {
    name: string;
    description?: string;
    inputSchema: TSchema;
    varHints?: {
        name: string;
        required?: boolean;
        description?: string;
    }[];
    /** Intrinsic tags for this tool. Merged with tags provided to `addTool()`. */
    tags?: string[];
    execute: (input: TSchema extends ZodSchema<infer T> ? T : unknown, ctx: ToolContext) => Promise<ToolResult>;
}): Tool<TSchema extends ZodSchema<infer T> ? T : unknown>;
declare function isTool(obj: unknown): obj is Tool;

/**
 * Runtime Configuration Defaults
 *
 * These values can be overridden via agent vars (set at agency or blueprint level).
 * Setting a value to 0 disables the corresponding limit/feature.
 */
/**
 * API key for the LLM provider.
 * Can be set globally via environment variable or per-agency/agent via vars.
 *
 * @var LLM_API_KEY
 * @env LLM_API_KEY
 * @required true
 */
declare const VAR_LLM_API_KEY = "LLM_API_KEY";
/**
 * Base URL for the LLM API (OpenAI-compatible endpoint).
 * Defaults to OpenAI's API if not set.
 *
 * @var LLM_API_BASE
 * @env LLM_API_BASE
 * @default "https://api.openai.com/v1"
 * @example "https://openrouter.ai/api/v1"
 * @example "https://api.anthropic.com/v1"
 */
declare const VAR_LLM_API_BASE = "LLM_API_BASE";
declare const DEFAULT_LLM_API_BASE = "https://api.openai.com/v1";
/**
 * Default model to use when not specified in the blueprint.
 *
 * @var DEFAULT_MODEL
 * @default undefined (must be set in blueprint or vars)
 */
declare const VAR_DEFAULT_MODEL = "DEFAULT_MODEL";
/**
 * Maximum number of retries for LLM requests.
 *
 * @var LLM_RETRY_MAX
 * @default 2
 * @example 0 disables retries
 */
declare const VAR_LLM_RETRY_MAX = "LLM_RETRY_MAX";
declare const DEFAULT_LLM_RETRY_MAX = 2;
/**
 * Base backoff delay in milliseconds for LLM retries.
 *
 * @var LLM_RETRY_BACKOFF_MS
 * @default 500
 */
declare const VAR_LLM_RETRY_BACKOFF_MS = "LLM_RETRY_BACKOFF_MS";
declare const DEFAULT_LLM_RETRY_BACKOFF_MS = 500;
/**
 * Maximum backoff delay in milliseconds for LLM retries.
 *
 * @var LLM_RETRY_MAX_BACKOFF_MS
 * @default 8000
 */
declare const VAR_LLM_RETRY_MAX_BACKOFF_MS = "LLM_RETRY_MAX_BACKOFF_MS";
declare const DEFAULT_LLM_RETRY_MAX_BACKOFF_MS = 8000;
/**
 * Jitter ratio applied to LLM retry backoff delays.
 *
 * @var LLM_RETRY_JITTER_RATIO
 * @default 0.2
 */
declare const VAR_LLM_RETRY_JITTER_RATIO = "LLM_RETRY_JITTER_RATIO";
declare const DEFAULT_LLM_RETRY_JITTER_RATIO = 0.2;
/**
 * Comma-separated list of HTTP status codes eligible for retry.
 *
 * @var LLM_RETRY_STATUS_CODES
 * @default "429,500,502,503,504"
 */
declare const VAR_LLM_RETRY_STATUS_CODES = "LLM_RETRY_STATUS_CODES";
declare const DEFAULT_LLM_RETRY_STATUS_CODES: number[];
/**
 * Maximum number of agent loop iterations before stopping with an error.
 * Each iteration involves either an LLM call or tool execution batch.
 *
 * @var MAX_ITERATIONS
 * @default 200
 * @example Set to 0 to disable the limit
 */
declare const DEFAULT_MAX_ITERATIONS = 200;
/**
 * Maximum number of tool calls to execute in parallel per tick.
 * Larger values increase throughput but may hit rate limits.
 *
 * @var MAX_TOOLS_PER_TICK (not currently configurable via vars)
 * @default 25
 */
declare const MAX_TOOLS_PER_TICK = 25;
/**
 * Number of recent messages to keep in full when summarizing.
 * These messages are not included in the summary and remain as-is.
 *
 * @var CONTEXT_KEEP_RECENT
 * @default 20
 */
declare const DEFAULT_CONTEXT_KEEP_RECENT = 20;
/**
 * Trigger summarization when message count exceeds this threshold.
 * Should be greater than CONTEXT_KEEP_RECENT.
 *
 * @var CONTEXT_SUMMARIZE_AT
 * @default 40
 */
declare const DEFAULT_CONTEXT_SUMMARIZE_AT = 40;
/**
 * Optional: Name of the memory disk to store extracted memories.
 * If not set, memories extracted during summarization are discarded.
 *
 * @var CONTEXT_MEMORY_DISK
 * @default undefined
 */
declare const DEFAULT_CONTEXT_MEMORY_DISK: string | undefined;
/**
 * Optional: Model to use for summarization.
 * If not set, uses the agent's default model.
 *
 * @var CONTEXT_SUMMARY_MODEL
 * @default undefined (uses agent model)
 */
declare const DEFAULT_CONTEXT_SUMMARY_MODEL: string | undefined;

export { AgentBlueprint, AgentHub, AgentPlugin, CfCtx, type ChatCompletionsOptions, type ChatCompletionsRetryOptions, ChatMessage, DEFAULT_CONTEXT_KEEP_RECENT, DEFAULT_CONTEXT_MEMORY_DISK, DEFAULT_CONTEXT_SUMMARIZE_AT, DEFAULT_CONTEXT_SUMMARY_MODEL, DEFAULT_LLM_API_BASE, DEFAULT_LLM_RETRY_BACKOFF_MS, DEFAULT_LLM_RETRY_JITTER_RATIO, DEFAULT_LLM_RETRY_MAX, DEFAULT_LLM_RETRY_MAX_BACKOFF_MS, DEFAULT_LLM_RETRY_STATUS_CODES, DEFAULT_MAX_ITERATIONS, type HandlerOptions, HubAgent, MAX_TOOLS_PER_TICK, type McpToolInfo, type MockResponse, ModelRequest, ModelResult, type PluginInfo, Provider, TestProvider, Tool, ToolCall, type ToolCallExpectation, ToolContext, type ToolInfo, ToolJsonSchema, type ToolResult, VAR_DEFAULT_MODEL, VAR_LLM_API_BASE, VAR_LLM_API_KEY, VAR_LLM_RETRY_BACKOFF_MS, VAR_LLM_RETRY_JITTER_RATIO, VAR_LLM_RETRY_MAX, VAR_LLM_RETRY_MAX_BACKOFF_MS, VAR_LLM_RETRY_STATUS_CODES, createEchoProvider, createHandler, createTestProvider, createToolCallProvider, filterMcpToolsByCapabilities, isTool, makeChatCompletions, tool };
