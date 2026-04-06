import { env } from 'cloudflare:workers';
import { Agent, AgentContext, Connection } from 'agents';
import { SqlStorage } from '@cloudflare/workers-types';

interface Provider {
    invoke(req: ModelRequest, opts: {
        signal?: AbortSignal;
    }): Promise<ModelResult>;
    stream(req: ModelRequest, onDelta: (chunk: string) => void): Promise<ModelResult>;
}
type ModelResult = {
    message: ChatMessage;
    usage?: {
        promptTokens: number;
        completionTokens: number;
        costUsd?: number;
    };
};
declare function parseModel(m: string): string;

/**
 * Event types following OpenTelemetry GenAI semantic conventions.
 * See: https://opentelemetry.io/docs/specs/semconv/gen-ai/
 *
 * Naming convention:
 * - gen_ai.agent.* - Agent lifecycle events
 * - gen_ai.chat.* - LLM/model call events (OTel uses "chat" for inference)
 * - gen_ai.tool.* - Tool execution events
 * - gen_ai.content.* - Content/message events
 */
declare enum AgentEventType {
    AGENT_INVOKED = "gen_ai.agent.invoked",// Agent run started
    AGENT_STEP = "gen_ai.agent.step",// Agent tick/iteration
    AGENT_PAUSED = "gen_ai.agent.paused",// Waiting for input (HITL, subagent, etc)
    AGENT_RESUMED = "gen_ai.agent.resumed",// Resumed after pause
    AGENT_COMPLETED = "gen_ai.agent.completed",// Agent finished successfully
    AGENT_ERROR = "gen_ai.agent.error",// Agent failed
    AGENT_CANCELED = "gen_ai.agent.canceled",// Agent was canceled
    CHAT_START = "gen_ai.chat.start",// LLM request started
    CHAT_CHUNK = "gen_ai.chat.chunk",// Streaming chunk received
    CHAT_FINISH = "gen_ai.chat.finish",// LLM response completed
    TOOL_START = "gen_ai.tool.start",// Tool execution started
    TOOL_FINISH = "gen_ai.tool.finish",// Tool execution completed
    TOOL_ERROR = "gen_ai.tool.error",// Tool execution failed
    CONTENT_MESSAGE = "gen_ai.content.message",// Assistant message (text or tool calls)
    SYSTEM_THREAD_CREATED = "gen_ai.system.thread_created",
    SYSTEM_REQUEST_ACCEPTED = "gen_ai.system.request_accepted",
    SYSTEM_CHECKPOINT = "gen_ai.system.checkpoint",
    PLUGIN_HOOK = "gen_ai.plugin.hook"
}
declare const LegacyEventTypeMap: Record<string, AgentEventType>;
type AgentEvent = {
    ts: string;
    seq?: number;
} & (AgentEventData | CustomEventData);
type CustomEventData = {
    type: string;
    data: Record<string, unknown>;
};
/**
 * Event data using OTel attribute naming conventions.
 * See: https://opentelemetry.io/docs/specs/semconv/registry/attributes/gen-ai/
 */
type AgentEventData = {
    type: AgentEventType.AGENT_INVOKED;
    data: Record<string, never>;
} | {
    type: AgentEventType.AGENT_STEP;
    data: {
        step: number;
    };
} | {
    type: AgentEventType.AGENT_PAUSED;
    data: {
        reason: "hitl" | "error" | "exhausted" | "subagent";
    };
} | {
    type: AgentEventType.AGENT_RESUMED;
    data: Record<string, never>;
} | {
    type: AgentEventType.AGENT_COMPLETED;
    data: {
        result?: unknown;
    };
} | {
    type: AgentEventType.AGENT_ERROR;
    data: {
        "error.type": string;
        "error.message"?: string;
        "error.stack"?: string;
    };
} | {
    type: AgentEventType.AGENT_CANCELED;
    data: Record<string, never>;
} | {
    type: AgentEventType.CHAT_START;
    data: {
        "gen_ai.request.model": string;
    };
} | {
    type: AgentEventType.CHAT_CHUNK;
    data: {
        "gen_ai.content.chunk": string;
    };
} | {
    type: AgentEventType.CHAT_FINISH;
    data: {
        "gen_ai.usage.input_tokens"?: number;
        "gen_ai.usage.output_tokens"?: number;
        "gen_ai.response.model"?: string;
    };
} | {
    type: AgentEventType.TOOL_START;
    data: {
        "gen_ai.tool.name": string;
        "gen_ai.tool.call.id"?: string;
        "gen_ai.tool.arguments"?: unknown;
    };
} | {
    type: AgentEventType.TOOL_FINISH;
    data: {
        "gen_ai.tool.name": string;
        "gen_ai.tool.call.id": string;
        "gen_ai.tool.response"?: unknown;
    };
} | {
    type: AgentEventType.TOOL_ERROR;
    data: {
        "gen_ai.tool.name": string;
        "gen_ai.tool.call.id": string;
        "error.type": string;
        "error.message"?: string;
    };
} | {
    type: AgentEventType.CONTENT_MESSAGE;
    data: {
        "gen_ai.content.text"?: string;
        "gen_ai.content.tool_calls"?: Array<{
            id: string;
            name: string;
            arguments: unknown;
        }>;
    };
} | {
    type: AgentEventType.SYSTEM_THREAD_CREATED;
    data: {
        "gen_ai.conversation.id": string;
    };
} | {
    type: AgentEventType.SYSTEM_REQUEST_ACCEPTED;
    data: {
        idempotencyKey: string;
    };
} | {
    type: AgentEventType.SYSTEM_CHECKPOINT;
    data: {
        stateHash: string;
        size: number;
    };
} | {
    type: AgentEventType.PLUGIN_HOOK;
    data: {
        hook: "before_model" | "after_model";
        pluginName: string;
    };
};

type ContextCheckpoint = {
    id: number;
    summary: string;
    messagesStartSeq: number;
    messagesEndSeq: number;
    archivedPath?: string;
    createdAt: number;
};
declare class Store {
    private sql;
    constructor(sql: SqlStorage);
    init(): void;
    add(input: ChatMessage | ChatMessage[]): void;
    getContext(limit?: number): ChatMessage[];
    lastAssistant(): ChatMessage | null;
    addEvent(e: AgentEvent): number;
    listEvents(): AgentEvent[];
    private _mapRows;
    getMessageCount(): number;
    getMessagesAfter(afterSeq: number, limit?: number): ChatMessage[];
    getMessagesInRange(startSeq: number, endSeq: number): ChatMessage[];
    getLatestCheckpoint(): ContextCheckpoint | null;
    addCheckpoint(summary: string, messagesStartSeq: number, messagesEndSeq: number, archivedPath?: string): number;
    deleteMessagesBefore(beforeSeq: number): number;
    getMaxMessageSeq(): number;
    getCheckpointCount(): number;
}

type FSEntry = {
    type: "file" | "dir";
    /** Path relative to the agent's view (e.g., "foo.txt" or "/shared/config.json") */
    path: string;
    size?: number;
    ts?: Date;
    owner?: string;
};
type AgentFSContext = {
    agencyId: string;
    agentId: string;
};
declare class AgentFileSystem {
    private bucket;
    private ctx;
    constructor(bucket: R2Bucket, ctx: AgentFSContext);
    private get homePrefix();
    private get sharedPrefix();
    private get agencyPrefix();
    resolvePath(userPath: string): string;
    toUserPath(r2Key: string): string;
    private objToEntry;
    checkAccess(r2Key: string, mode: "read" | "write"): {
        allowed: boolean;
        reason?: string;
    };
    readDir(path?: string): Promise<FSEntry[]>;
    delete(paths: string[]): Promise<void>;
    stat(path: string): Promise<FSEntry | null>;
    writeFile(path: string, data: string | ArrayBuffer | Uint8Array): Promise<void>;
    readFile(path: string, stream: true): Promise<ReadableStream | null>;
    readFile(path: string, stream?: false): Promise<string | null>;
    editFile(path: string, oldStr: string, newStr: string, replaceAll?: boolean): Promise<{
        replaced: number;
        content: string;
    }>;
    exists(path: string): Promise<boolean>;
}

/** Event relayed from agent to agency */
type AgencyRelayEvent = AgentEvent & {
    agentId: string;
    agentType: string;
};
type Info = {
    threadId: string;
    agencyId: string;
    createdAt: string;
    request: ThreadRequestContext;
    agentType: string;
    pendingToolCalls?: ToolCall[];
    blueprint?: AgentBlueprint;
};
declare abstract class HubAgent<Env extends AgentEnv = AgentEnv> extends Agent<Env> {
    protected _tools: Record<string, Tool<any>>;
    private _fs;
    /** WebSocket connection to Agency for event relay during active runs */
    private _agencyWs;
    private _agencyWsConnecting;
    readonly info: Info;
    readonly runState: RunState;
    /** Open-typed persisted metadata, accessible to all plugins */
    readonly vars: Record<string, unknown>;
    store: Store;
    observability: undefined;
    constructor(ctx: AgentContext, env: Env);
    abstract get blueprint(): AgentBlueprint;
    abstract get plugins(): AgentPlugin[];
    abstract get tools(): Record<string, Tool<any>>;
    abstract get provider(): Provider;
    abstract onRegister(meta: ThreadMetadata): Promise<void>;
    get kv(): SyncKvStorage;
    get sqlite(): <T = Record<string, string | number | boolean | null>>(strings: TemplateStringsArray, ...values: (string | number | boolean | null)[]) => T[];
    get exports(): Exports;
    get messages(): ChatMessage[];
    get model(): string;
    /** R2-backed filesystem with per-agent home directory and shared space. */
    get fs(): AgentFileSystem;
    get pluginContext(): PluginContext;
    get isPaused(): boolean;
    onRequest(req: Request): Promise<Response>;
    scheduleStep(): Promise<void>;
    ensureScheduled(): Promise<void>;
    registerThread(req: Request): Promise<Response>;
    invoke(req: Request): Promise<Response>;
    protected _pluginsInitialized: boolean;
    run(): Promise<void>;
    action(req: Request): Promise<Response>;
    getState(_req: Request): Response;
    getEvents(_req: Request): Response;
    executePendingTools(maxTools: number): Promise<void>;
    emit(type: AgentEventType | string, data: Record<string, unknown>): void;
    /**
     * Connect to the Agency via WebSocket for event relay.
     * Called when a run starts. The Agency stays awake while agents have active runs.
     */
    protected connectToAgency(): Promise<void>;
    /**
     * Disconnect from the Agency WebSocket.
     * Called when a run completes, errors, or is canceled.
     */
    protected disconnectFromAgency(): void;
    /**
     * Relay an event to the Agency via WebSocket.
     */
    private relayEventToAgency;
}

declare class ModelPlanBuilder {
    private readonly agent;
    private sysParts;
    private _toolChoice;
    private _responseFormat;
    private _temperature?;
    private _maxTokens?;
    private _stop?;
    private _model?;
    private _messages?;
    constructor(agent: HubAgent);
    addSystemPrompt(...parts: Array<string | undefined | null>): void;
    setModel(id?: string): void;
    setToolChoice(choice: ModelRequest["toolChoice"]): void;
    setResponseFormat(fmt: ModelRequest["responseFormat"]): void;
    setTemperature(t?: number): void;
    setMaxTokens(n?: number): void;
    setStop(stop?: string[]): void;
    setMessages(messages: ChatMessage[]): void;
    build(): ModelRequest;
}

type McpServerStatus = "authenticating" | "connecting" | "connected" | "discovering" | "ready" | "failed";
interface McpServerConfig {
    id: string;
    name: string;
    url: string;
    status: McpServerStatus;
    authUrl?: string;
    error?: string;
}
declare class Agency extends Agent<AgentEnv> {
    private _cachedAgencyName;
    /** Agency-level vars inherited by all spawned agents */
    readonly vars: Record<string, unknown>;
    private _router;
    observability: undefined;
    onStart(): void;
    get exports(): Exports;
    private get router();
    private createRouter;
    get agencyName(): string;
    private persistName;
    constructor(ctx: AgentContext, env: AgentEnv);
    onRequest(req: Request): Promise<Response>;
    private handleSetVars;
    private handleGetVar;
    private handleSetVar;
    private handleDeleteVar;
    private handleListMcpServers;
    private handleAddMcpServer;
    private handleRemoveMcpServer;
    private handleRetryMcpServer;
    /**
     * Call an MCP tool. Used by agents to proxy tool calls through the Agency.
     */
    private handleMcpToolCall;
    /**
     * Get available MCP tools. Used by agents to discover tools from connected servers.
     */
    private handleListMcpTools;
    /**
     * Convert SDK's MCPServersState to our McpServerConfig array
     */
    private convertMcpStateToServers;
    /**
     * Get all configured MCP servers in our format.
     */
    listMcpServersConfig(): McpServerConfig[];
    private handleGetInternalBlueprint;
    /**
     * Broadcast an agent event to all subscribed UI WebSocket clients.
     * Excludes agent connections (they only send, not receive).
     */
    private broadcastAgentEvent;
    /**
     * Handle new WebSocket connections.
     * Identifies agent connections from request headers.
     */
    onConnect(connection: Connection, ctx: {
        request: Request;
    }): void;
    /**
     * Handle incoming WebSocket messages.
     * - UI clients: subscription management (subscribe/unsubscribe)
     * - Agents: event relay
     */
    onMessage(connection: Connection, message: string | ArrayBuffer): void;
    listDbBlueprints(): AgentBlueprint[];
    private handleCreateBlueprint;
    private handleDeleteBlueprint;
    private handlePresence;
    /**
     * Register an agent in the agents table so presence discovery can find it.
     * Called by the worker when a client WebSocket connects to a HubAgent DO
     * that may not have been created through POST /agents.
     */
    private handleRegisterAgent;
    private handleListAgents;
    private handleCreateAgent;
    private handleDeleteAgent;
    /**
     * Get the tree of agents related to a specific agent.
     * Returns the agent, its ancestors (via relatedAgentId chain), and descendants.
     */
    private handleGetAgentTree;
    /**
     * Get the full forest of agents organized as trees.
     * Root agents are those without a relatedAgentId.
     */
    private handleGetAgentForest;
    spawnAgent(agentType: string, requestContext?: ThreadRequestContext, input?: Record<string, unknown>, relatedAgentId?: string, providedId?: string): Promise<Response>;
    private handleListSchedules;
    private handleCreateSchedule;
    private handleGetSchedule;
    private handleUpdateSchedule;
    private handleDeleteSchedule;
    private handlePauseSchedule;
    private handleResumeSchedule;
    private handleTriggerSchedule;
    private handleGetScheduleRuns;
    /**
     * Callback method invoked by Agent's alarm system
     */
    runScheduledAgent(payload: {
        id: string;
    }): Promise<void>;
    private executeSchedule;
    private scheduleNextRun;
    private handleDeleteAgency;
    private getScheduleById;
    private getRunById;
    private deleteAgentResources;
    private deletePrefix;
    private computeNextRun;
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
    private handleFilesystem;
    private handleFsGet;
    private handleFsPut;
    private handleFsDelete;
    /**
     * Get aggregated metrics for this agency.
     * Returns counts and stats computed from local state (schedules, agents).
     *
     * Note: For full Analytics Engine queries, use the SQL API directly with
     * ACCOUNT_ID and API_TOKEN. This endpoint provides basic real-time counts.
     */
    private handleGetMetrics;
}

/** Lifecycle status of an agent run. */
type RunStatus = "idle" | "registered" | "running" | "paused" | "completed" | "canceled" | "error";
/** Mutable state tracking the progress of an agent run. */
type RunState = {
    status: RunStatus;
    step: number;
    reason?: string;
    nextAlarmAt?: number | null;
};
/** Full observable state of an agent, returned via the `/state` endpoint. */
type AgentState = {
    messages: ChatMessage[];
    tools: ToolMeta[];
    thread: ThreadMetadata;
    threadId?: string;
    agentType?: string;
    model?: string;
} & Record<string, unknown>;
interface ApproveBody {
    approved: boolean;
    modifiedToolCalls?: ToolCall[];
}
type ToolCall = {
    name: string;
    args: unknown;
    id: string;
};
type ToolJsonSchema = Record<string, unknown>;
/** Metadata describing a tool for the LLM (name, description, JSON Schema). */
type ToolMeta = {
    name: string;
    description?: string;
    parameters?: ToolJsonSchema;
};
type ChatMessageBase = {
    /** Timestamp when the message was created (ISO string). */
    ts?: string;
};
/** A block of content within a multimodal message. */
type ContentBlock = {
    type: "text";
    text: string;
} | {
    type: "image_url";
    image_url: {
        url: string;
        detail?: string;
    };
};
/** A single message in the conversation (user, assistant, system, or tool result). */
type ChatMessage = ChatMessageBase & ({
    role: "system" | "user";
    content: string | ContentBlock[];
} | {
    role: "assistant";
    reasoning?: string;
    content: string;
} | {
    role: "assistant";
    reasoning?: string;
    toolCalls: ToolCall[];
} | {
    role: "tool";
    content: string;
    toolCallId: string;
});
/** A file attachment sent with an invoke request. */
interface Attachment {
    filename: string;
    mimeType: string;
    /** Base64-encoded file content. */
    data: string;
}
/** Request body for the `/invoke` endpoint. */
interface InvokeBody {
    threadId?: string;
    messages?: ChatMessage[];
    files?: Record<string, string>;
    /** File attachments to merge into the last user message as multimodal content blocks. */
    attachments?: Attachment[];
    idempotencyKey?: string;
    agentType?: string;
    tags?: string[];
    vars?: Record<string, unknown>;
}
/** Request payload sent to the LLM provider. */
interface ModelRequest {
    model: string;
    systemPrompt?: string;
    messages: ChatMessage[];
    tools?: string[];
    toolDefs?: ToolMeta[];
    toolChoice?: "auto" | "required" | "none" | {
        type: "function";
        function: {
            name: string;
        };
    };
    responseFormat?: "text" | "json" | {
        schema: unknown;
    };
    temperature?: number;
    maxTokens?: number;
    stop?: string[];
}
/** HTTP request context captured when a thread is created. */
type ThreadRequestContext = {
    userAgent?: string;
    ip?: string;
    referrer?: string;
    origin?: string;
    cf?: Record<string, unknown>;
};
/** Immutable metadata for an agent thread. */
interface ThreadMetadata {
    id: string;
    createdAt: string;
    request: ThreadRequestContext;
    agentType: string;
    agencyId: string;
    vars?: Record<string, unknown>;
}
interface CreateThreadRequest {
    agentType?: string;
    metadata?: Record<string, unknown>;
}
type SubagentLinkStatus = "waiting" | "completed" | "canceled";
interface SubagentLink {
    childThreadId: string;
    token: string;
    status: SubagentLinkStatus;
    createdAt: number;
    completedAt?: number;
    report?: string;
    toolCallId?: string;
}
type BlueprintStatus = "active" | "draft" | "disabled";
/**
 * Defines an agent's behavior: prompt, model, capabilities, and vars.
 * Registered with an agency and used to spawn agent instances.
 */
type AgentBlueprint = {
    name: string;
    description: string;
    prompt: string;
    /**
     * Capabilities determine which tools and plugins are available to this agent.
     * - `@tag` - includes all tools/plugins with that tag (e.g., `@security`, `@default`)
     * - `name` - includes a specific tool/plugin by name (e.g., `write_file`, `planning`)
     */
    capabilities: string[];
    model?: string;
    /**
     * Variables accessible to plugins and the agent at runtime.
     * These are merged with agency vars and can be overridden at registration/invocation.
     */
    vars?: Record<string, unknown>;
    status?: BlueprintStatus;
    createdAt?: string;
    updatedAt?: string;
};
/** Analytics Engine dataset binding for metrics */
interface AnalyticsEngineDataset {
    writeDataPoint(event: {
        blobs?: string[];
        doubles?: number[];
        indexes?: string[];
    }): void;
}
/** Environment bindings required by the AgentHub runtime. */
interface AgentEnv {
    HUB_AGENT: DurableObjectNamespace<HubAgent>;
    AGENCY: DurableObjectNamespace<Agency>;
    LLM_API_KEY?: string;
    LLM_API_BASE?: string;
    LLM_RETRY_MAX?: string | number;
    LLM_RETRY_BACKOFF_MS?: string | number;
    LLM_RETRY_MAX_BACKOFF_MS?: string | number;
    LLM_RETRY_JITTER_RATIO?: string | number;
    LLM_RETRY_STATUS_CODES?: string;
    FS?: R2Bucket;
    SANDBOX?: DurableObjectNamespace;
    /** Analytics Engine dataset for agent metrics */
    METRICS?: AnalyticsEngineDataset;
    /** Cloudflare Account ID (for querying Analytics Engine SQL API) */
    CF_ACCOUNT_ID?: string;
    /** API Token with Analytics Read permission (for querying Analytics Engine SQL API) */
    CF_API_TOKEN?: string;
}
/** Context passed to plugin hooks, providing access to the agent and tool registration. */
type PluginContext = {
    agent: HubAgent;
    env: AgentEnv;
    registerTool: <T>(tool: Tool<T>) => void;
};
/** Declares a variable that a plugin or tool expects to be set. */
interface VarHint {
    name: string;
    required?: boolean;
    description?: string;
}
/**
 * Extends agent behavior with lifecycle hooks, tools, state, and actions.
 * Plugins are matched to agents via tags in the blueprint's `capabilities`.
 */
interface AgentPlugin {
    actions?: Record<string, (ctx: PluginContext, payload: unknown) => Promise<unknown>>;
    name: string;
    /** Hints about vars this plugin needs */
    varHints?: VarHint[];
    /**
     * Agents with this blueprint will include this plugin's state in their state.
     */
    state?: (ctx: PluginContext) => Record<string, unknown>;
    /**
     * Hook called when an agent with this plugin is registered. Only called once.
     */
    onInit?(ctx: PluginContext): Promise<void>;
    /**
     * Hook called at the beginning of each tick. Once per each LLM -> tool exec iterations.
     */
    onTick?(ctx: PluginContext): Promise<void>;
    /**
     * Hook called before the model is invoked. Useful to add or modify the model request.
     * e.g. add tools, modify system prompt, etc.
     */
    beforeModel?(ctx: PluginContext, plan: ModelPlanBuilder): Promise<void>;
    /**
     * Hook called once the LLM response is received and before any tools are executed.
     */
    onModelResult?(ctx: PluginContext, res: {
        message: ChatMessage;
    }): Promise<void>;
    /**
     * Hook called before a tool is executed. Executed once per tool call.
     */
    onToolStart?(ctx: PluginContext, call: ToolCall): Promise<void>;
    /**
     * Hook called after a tool is executed. Executed once per tool call.
     */
    onToolResult?(ctx: PluginContext, call: ToolCall, result: unknown): Promise<void>;
    /**
     * Hook called after a tool is executed. Executed once per tool call.
     */
    onToolError?(ctx: PluginContext, call: ToolCall, error: Error): Promise<void>;
    /**
     * Hook called when the agent has no more tools to call and has returned a final text.
     */
    onRunComplete?(ctx: PluginContext, result: {
        final: string;
    }): Promise<void>;
    /**
     * Hook called when the agent emits an event.
     */
    onEvent?(ctx: PluginContext, event: AgentEvent): void;
    tags: string[];
}
/**
 * A callable tool exposed to the LLM. Create via `tool()` from `agent-hub`.
 */
interface Tool<TInput = unknown> {
    meta: ToolMeta;
    execute: (input: TInput, ctx: ToolContext) => Promise<string | object | null>;
    varHints?: VarHint[];
    /** Intrinsic tags for this tool. Merged with tags provided to `addTool()`. */
    tags?: string[];
}
/** Context passed to a tool's execute function. */
type ToolContext = {
    agent: HubAgent;
    env: typeof env;
    callId: string;
};
type Exports = {
    HubAgent: DurableObjectNamespace<HubAgent>;
    Agency: DurableObjectNamespace<Agency>;
};
type CfCtx = ExecutionContext & {
    exports: Exports;
};

export { type AgentBlueprint as A, type SubagentLinkStatus as B, type ChatMessage as C, type ThreadMetadata as D, type Exports as E, type FSEntry as F, type ThreadRequestContext as G, HubAgent as H, type Info as I, type ToolMeta as J, parseModel as K, LegacyEventTypeMap as L, type ModelResult as M, type Provider as P, type RunState as R, type SubagentLink as S, type ToolCall as T, type VarHint as V, type ModelRequest as a, type CfCtx as b, type Tool as c, type AgentPlugin as d, Agency as e, type ToolJsonSchema as f, type ToolContext as g, type AgencyRelayEvent as h, type AgentEnv as i, type AgentEvent as j, type AgentEventData as k, AgentEventType as l, type AgentFSContext as m, AgentFileSystem as n, type AgentState as o, type AnalyticsEngineDataset as p, type ApproveBody as q, type Attachment as r, type ChatMessageBase as s, type ContentBlock as t, type CreateThreadRequest as u, type CustomEventData as v, type InvokeBody as w, ModelPlanBuilder as x, type PluginContext as y, type RunStatus as z };
