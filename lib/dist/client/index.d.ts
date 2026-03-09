import { A as AgentBlueprint, y as ThreadMetadata, o as AgentState, S as SubagentLink, R as RunState, j as AgentEvent, C as ChatMessage, q as ApproveBody } from '../types-ROueRolu.js';
export { l as AgentEventType, u as InvokeBody, T as ToolCall, B as ToolMeta } from '../types-ROueRolu.js';
import 'cloudflare:workers';
import 'agents';
import '@cloudflare/workers-types';

interface AgencyMeta {
    id: string;
    name: string;
    createdAt: string;
}
type AgentScheduleType = "once" | "cron" | "interval";
type OverlapPolicy = "skip" | "queue" | "allow";
type ScheduleStatus = "active" | "paused" | "disabled";
type ScheduleRunStatus = "pending" | "running" | "completed" | "failed" | "skipped";
interface AgentSchedule {
    id: string;
    name: string;
    agentType: string;
    input?: Record<string, unknown>;
    type: AgentScheduleType;
    runAt?: string;
    cron?: string;
    intervalMs?: number;
    status: ScheduleStatus;
    timezone?: string;
    maxRetries?: number;
    timeoutMs?: number;
    overlapPolicy: OverlapPolicy;
    createdAt: string;
    updatedAt: string;
    lastRunAt?: string;
    nextRunAt?: string;
}
interface ScheduleRun {
    id: string;
    scheduleId: string;
    agentId?: string;
    status: ScheduleRunStatus;
    scheduledAt: string;
    startedAt?: string;
    completedAt?: string;
    error?: string;
    result?: string;
    retryCount: number;
}
interface CreateScheduleRequest {
    name: string;
    agentType: string;
    input?: Record<string, unknown>;
    type: AgentScheduleType;
    runAt?: string;
    cron?: string;
    intervalMs?: number;
    timezone?: string;
    maxRetries?: number;
    timeoutMs?: number;
    overlapPolicy?: OverlapPolicy;
}
interface UpdateScheduleRequest {
    name?: string;
    agentType?: string;
    input?: Record<string, unknown>;
    type?: AgentScheduleType;
    runAt?: string;
    cron?: string;
    intervalMs?: number;
    timezone?: string;
    maxRetries?: number;
    timeoutMs?: number;
    overlapPolicy?: OverlapPolicy;
}
/** Response from GET /agency/:id/schedules */
interface ListSchedulesResponse {
    schedules: AgentSchedule[];
}
/** Response from schedule operations */
interface ScheduleResponse {
    schedule: AgentSchedule;
}
/** Response from GET /agency/:id/schedules/:id/runs */
interface ListScheduleRunsResponse {
    runs: ScheduleRun[];
}
/** Response from POST /agency/:id/schedules/:id/trigger */
interface TriggerScheduleResponse {
    run: ScheduleRun;
}
interface FSEntry {
    type: "file" | "dir";
    path: string;
    size?: number;
    modified?: string;
}
interface ListDirectoryResponse {
    path: string;
    entries: FSEntry[];
}
interface ReadFileResponse {
    content: string;
    path: string;
    size: number;
    modified: string;
}
interface WriteFileResponse {
    ok: boolean;
    path: string;
    size: number;
}
interface DeleteFileResponse {
    ok: boolean;
    path: string;
}
interface GetVarsResponse {
    vars: Record<string, unknown>;
}
/** Response from GET /agency/:id/metrics */
interface GetMetricsResponse {
    agents: {
        total: number;
        byType: Record<string, number>;
    };
    schedules: {
        total: number;
        active: number;
        paused: number;
        disabled: number;
    };
    runs: {
        today: number;
        completed: number;
        failed: number;
        successRate: number;
    };
    timestamp: string;
}
/** Response from GET /agency/:id/vars/:key */
interface GetVarResponse {
    key: string;
    value: unknown;
}
/** Response from PUT /agency/:id/vars or vars/:key */
interface SetVarResponse {
    ok: boolean;
    key?: string;
    value?: unknown;
    vars?: Record<string, unknown>;
}
interface ListAgenciesResponse {
    agencies: AgencyMeta[];
}
interface VarHint {
    name: string;
    required?: boolean;
    description?: string;
}
interface PluginInfo {
    name: string;
    tags: string[];
    varHints?: VarHint[];
}
interface ToolInfo {
    name: string;
    description?: string;
    tags: string[];
    varHints?: VarHint[];
}
interface GetPluginsResponse {
    plugins: PluginInfo[];
    tools: ToolInfo[];
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
interface AddMcpServerRequest {
    name: string;
    url: string;
    headers?: Record<string, string>;
}
interface McpToolInfo {
    serverId: string;
    name: string;
    description?: string;
    inputSchema?: Record<string, unknown>;
}
interface ListMcpToolsResponse {
    tools: McpToolInfo[];
}
interface ListMcpServersResponse {
    servers: McpServerConfig[];
}
interface McpServerResponse {
    server: McpServerConfig;
}
interface CreateAgencyResponse extends AgencyMeta {
}
interface ListBlueprintsResponse {
    blueprints: AgentBlueprint[];
}
interface CreateBlueprintResponse {
    ok: boolean;
    name: string;
}
interface AgentSummary {
    id: string;
    agentType: string;
    createdAt: string;
    request?: unknown;
    agencyId?: string;
    relatedAgentId?: string;
}
interface ListAgentsResponse {
    agents: AgentSummary[];
}
interface AgentTreeResponse {
    agent: AgentSummary;
    ancestors: AgentSummary[];
    descendants: AgentSummary[];
}
interface AgentNode extends AgentSummary {
    children: AgentNode[];
}
interface AgentForestResponse {
    roots: AgentNode[];
}
interface SpawnAgentResponse extends ThreadMetadata {
}
interface InvokeResponse {
    status: string;
}
interface GetStateResponse {
    state: AgentState & {
        subagents?: SubagentLink[];
    };
    run: RunState;
}
interface GetEventsResponse {
    events: AgentEvent[];
}
interface OkResponse {
    ok: boolean;
}
interface CreateAgencyRequest {
    name?: string;
}
interface CreateBlueprintRequest {
    name: string;
    description?: string;
    prompt: string;
    capabilities: string[];
    model?: string;
    config?: Record<string, unknown>;
    status?: "active" | "draft" | "disabled";
}
interface SpawnAgentRequest {
    agentType: string;
    relatedAgentId?: string;
    input?: Record<string, unknown>;
    /** Optional custom ID for the agent. If an agent with this ID exists, it will be resumed instead of created. */
    id?: string;
}
interface InvokeRequest {
    messages?: ChatMessage[];
    files?: Record<string, string>;
    idempotencyKey?: string;
}
type ApproveRequest = ApproveBody;
type WebSocketEvent = AgentEvent & {
    seq: number;
};
/** Event relayed from agents through the Agency */
type AgencyWebSocketEvent = AgentEvent & {
    seq: number;
    agentId: string;
    agentType: string;
};
/** Subscription message sent to Agency WebSocket */
type AgencySubscriptionMessage = {
    type: "subscribe";
    agentIds?: string[];
} | {
    type: "unsubscribe";
};
interface WebSocketOptions {
    /** Called when an event is received */
    onEvent?: (event: WebSocketEvent) => void;
    /** Called when the connection is opened */
    onOpen?: () => void;
    /** Called when the connection is closed */
    onClose?: (event: CloseEvent) => void;
    /** Called on error */
    onError?: (error: Event) => void;
    /** Custom protocols */
    protocols?: string | string[];
}
interface AgentWebSocket {
    ws: WebSocket;
    send: (message: unknown) => void;
    close: () => void;
}
interface AgencyWebSocketOptions {
    /** Called when an agent event is received */
    onEvent?: (event: AgencyWebSocketEvent) => void;
    /** Called when the connection is opened */
    onOpen?: () => void;
    /** Called when the connection is closed */
    onClose?: (event: CloseEvent) => void;
    /** Called on error */
    onError?: (error: Event) => void;
    /** Custom protocols */
    protocols?: string | string[];
}
interface AgencyWebSocket {
    ws: WebSocket;
    send: (message: unknown) => void;
    close: () => void;
    /** Subscribe to events from specific agents. If agentIds is omitted, receives all events. */
    subscribe: (agentIds?: string[]) => void;
    /** Unsubscribe from filtering - receive all events */
    unsubscribe: () => void;
}
interface AgentHubClientOptions {
    baseUrl: string;
    secret?: string;
    fetch?: typeof fetch;
}
/** Error thrown when an API request fails. */
declare class AgentHubError extends Error {
    status: number;
    body?: unknown | undefined;
    constructor(message: string, status: number, body?: unknown | undefined);
}
/** Client for interacting with a single agent instance. */
declare class AgentClient {
    private readonly baseUrl;
    private readonly agencyId;
    private readonly agentId;
    private readonly headers;
    private readonly fetchFn;
    constructor(baseUrl: string, agencyId: string, agentId: string, headers: HeadersInit, fetchFn: typeof fetch);
    private get path();
    private request;
    getState(): Promise<GetStateResponse>;
    getEvents(): Promise<GetEventsResponse>;
    invoke(request?: InvokeRequest): Promise<InvokeResponse>;
    action<T = unknown>(type: string, payload?: Record<string, unknown>): Promise<T>;
    connect(options?: WebSocketOptions): AgentWebSocket;
    get id(): string;
}
/** Client for managing an agency and its agents, blueprints, schedules, and files. */
declare class AgencyClient {
    private readonly baseUrl;
    private readonly agencyId;
    private readonly headers;
    private readonly fetchFn;
    constructor(baseUrl: string, agencyId: string, headers: HeadersInit, fetchFn: typeof fetch);
    private get path();
    private request;
    listBlueprints(): Promise<ListBlueprintsResponse>;
    createBlueprint(blueprint: CreateBlueprintRequest): Promise<CreateBlueprintResponse>;
    deleteBlueprint(name: string): Promise<{
        ok: boolean;
    }>;
    listAgents(): Promise<ListAgentsResponse>;
    spawnAgent(request: SpawnAgentRequest): Promise<SpawnAgentResponse>;
    deleteAgent(agentId: string): Promise<OkResponse>;
    getAgentTree(agentId: string): Promise<AgentTreeResponse>;
    getAgentForest(): Promise<AgentForestResponse>;
    agent(agentId: string): AgentClient;
    listSchedules(): Promise<ListSchedulesResponse>;
    createSchedule(request: CreateScheduleRequest): Promise<ScheduleResponse>;
    getSchedule(scheduleId: string): Promise<ScheduleResponse>;
    updateSchedule(scheduleId: string, request: UpdateScheduleRequest): Promise<ScheduleResponse>;
    deleteSchedule(scheduleId: string): Promise<OkResponse>;
    pauseSchedule(scheduleId: string): Promise<ScheduleResponse>;
    resumeSchedule(scheduleId: string): Promise<ScheduleResponse>;
    triggerSchedule(scheduleId: string): Promise<TriggerScheduleResponse>;
    getScheduleRuns(scheduleId: string): Promise<ListScheduleRunsResponse>;
    listDirectory(path?: string): Promise<ListDirectoryResponse>;
    readFile(path: string): Promise<ReadFileResponse>;
    writeFile(path: string, content: string): Promise<WriteFileResponse>;
    deleteFile(path: string): Promise<DeleteFileResponse>;
    getVars(): Promise<GetVarsResponse>;
    setVars(vars: Record<string, unknown>): Promise<SetVarResponse>;
    getVar(key: string): Promise<GetVarResponse>;
    setVar(key: string, value: unknown): Promise<SetVarResponse>;
    deleteVar(key: string): Promise<OkResponse>;
    listMcpServers(): Promise<ListMcpServersResponse>;
    addMcpServer(request: AddMcpServerRequest): Promise<McpServerResponse>;
    removeMcpServer(serverId: string): Promise<OkResponse>;
    retryMcpServer(serverId: string): Promise<McpServerResponse>;
    listMcpTools(): Promise<ListMcpToolsResponse>;
    deleteAgency(): Promise<OkResponse>;
    /**
     * Get aggregated metrics for this agency.
     * Returns counts and stats for agents, schedules, and recent runs.
     */
    getMetrics(): Promise<GetMetricsResponse>;
    /**
     * Connect to the agency-level WebSocket for real-time agent events.
     * This single connection receives events from all agents in the agency.
     *
     * @example
     * ```ts
     * const connection = agency.connect({
     *   onEvent: (event) => {
     *     console.log(`Event from ${event.agentId}:`, event.type);
     *   },
     * });
     *
     * // Subscribe to specific agents only
     * connection.subscribe(["agent-1", "agent-2"]);
     *
     * // Unsubscribe to receive all events
     * connection.unsubscribe();
     * ```
     */
    connect(options?: AgencyWebSocketOptions): AgencyWebSocket;
    get id(): string;
}
/**
 * Top-level client for interacting with the AgentHub API.
 *
 * @example
 * ```ts
 * const client = new AgentHubClient({ baseUrl: "https://hub.example.com" });
 * const { agencies } = await client.listAgencies();
 * const agency = client.agency(agencies[0].id);
 * const agent = agency.agent("my-agent-id");
 * await agent.invoke({ messages: [{ role: "user", content: "Hello" }] });
 * ```
 */
declare class AgentHubClient {
    private readonly baseUrl;
    private readonly headers;
    private readonly fetchFn;
    constructor(options: AgentHubClientOptions);
    private request;
    listAgencies(): Promise<ListAgenciesResponse>;
    getPlugins(): Promise<GetPluginsResponse>;
    createAgency(request?: CreateAgencyRequest): Promise<CreateAgencyResponse>;
    deleteAgency(agencyId: string): Promise<OkResponse>;
    agency(agencyId: string): AgencyClient;
}

export { type AddMcpServerRequest, AgencyClient, type AgencyMeta, type AgencySubscriptionMessage, type AgencyWebSocket, type AgencyWebSocketEvent, type AgencyWebSocketOptions, AgentBlueprint, AgentClient, AgentEvent, type AgentForestResponse, AgentHubClient, type AgentHubClientOptions, AgentHubError, type AgentNode, type AgentSchedule, type AgentScheduleType, AgentState, type AgentSummary, type AgentTreeResponse, type AgentWebSocket, ApproveBody, type ApproveRequest, ChatMessage, type CreateAgencyRequest, type CreateAgencyResponse, type CreateBlueprintRequest, type CreateBlueprintResponse, type CreateScheduleRequest, type DeleteFileResponse, type FSEntry, type GetEventsResponse, type GetMetricsResponse, type GetPluginsResponse, type GetStateResponse, type GetVarResponse, type GetVarsResponse, type InvokeRequest, type InvokeResponse, type ListAgenciesResponse, type ListAgentsResponse, type ListBlueprintsResponse, type ListDirectoryResponse, type ListMcpServersResponse, type ListMcpToolsResponse, type ListScheduleRunsResponse, type ListSchedulesResponse, type McpServerConfig, type McpServerResponse, type McpServerStatus, type McpToolInfo, type OkResponse, type OverlapPolicy, type PluginInfo, type ReadFileResponse, RunState, type ScheduleResponse, type ScheduleRun, type ScheduleRunStatus, type ScheduleStatus, type SetVarResponse, type SpawnAgentRequest, type SpawnAgentResponse, SubagentLink, ThreadMetadata, type ToolInfo, type TriggerScheduleResponse, type UpdateScheduleRequest, type VarHint, type WebSocketEvent, type WebSocketOptions, type WriteFileResponse };
