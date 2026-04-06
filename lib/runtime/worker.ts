import { Router, type IRequest } from "itty-router";
import { getAgentByName } from "agents";
import type { AgentBlueprint, CfCtx, ThreadRequestContext } from "./types";
import type { R2Bucket } from "@cloudflare/workers-types";
import type { HubAgent } from "./agent";
import type { Agency } from "./agency";
import { getAdminHtml } from "./admin-ui";

export type PluginInfo = {
  name: string;
  tags: string[];
  varHints?: Array<{ name: string; required?: boolean; description?: string }>;
};

export type ToolInfo = {
  name: string;
  description?: string;
  tags: string[];
  varHints?: Array<{ name: string; required?: boolean; description?: string }>;
};

export type HandlerOptions = {
  baseUrl?: string;
  agentDefinitions?: AgentBlueprint[];
  plugins?: PluginInfo[];
  tools?: ToolInfo[];
};

type HandlerEnv = {
  FS: R2Bucket;
};

type RequestContext = {
  env: HandlerEnv;
  ctx: CfCtx;
  opts: HandlerOptions;
};


const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "*",
  "Access-Control-Max-Age": "86400",
};

/**
 * Timing-safe string comparison to prevent timing attacks.
 * Returns true if strings are equal, false otherwise.
 */
function secureCompare(a: string | null, b: string): boolean {
  if (a === null) return false;
  
  // Ensure both strings are the same length by hashing
  // This prevents length-based timing attacks
  const encoder = new TextEncoder();
  const aBytes = encoder.encode(a);
  const bBytes = encoder.encode(b);
  
  // If lengths differ, we still need to do constant-time work
  // XOR all bytes and accumulate differences
  const maxLen = Math.max(aBytes.length, bBytes.length);
  let result = aBytes.length ^ bBytes.length; // Will be non-zero if lengths differ
  
  for (let i = 0; i < maxLen; i++) {
    const aByte = i < aBytes.length ? aBytes[i] : 0;
    const bByte = i < bBytes.length ? bBytes[i] : 0;
    result |= aByte ^ bByte;
  }
  
  return result === 0;
}

/**
 * Verify a Firebase ID token using Google's public keys.
 * Accepts tokens from both dev and prod Firebase projects.
 */
const FIREBASE_PROJECTS = [
  "co2-target-asset-tracking",
  "co2-target-asset-tracking-dev",
];
const GOOGLE_JWKS_URL = "https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com";

let cachedCerts: { keys: Record<string, CryptoKey>; expiresAt: number } | null = null;

async function fetchGoogleCerts(): Promise<Record<string, CryptoKey>> {
  if (cachedCerts && Date.now() < cachedCerts.expiresAt) {
    return cachedCerts.keys;
  }
  const res = await fetch(GOOGLE_JWKS_URL);
  if (!res.ok) return {};
  const jwks = await res.json() as { keys: Array<{ kid: string; kty: string; n: string; e: string; alg: string }> };

  const cc = res.headers.get("Cache-Control") || "";
  const maxAge = parseInt(cc.match(/max-age=(\d+)/)?.[1] || "3600", 10);

  const keys: Record<string, CryptoKey> = {};
  for (const jwk of jwks.keys || []) {
    try {
      keys[jwk.kid] = await crypto.subtle.importKey(
        "jwk",
        { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: "RS256", ext: true },
        { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
        false,
        ["verify"]
      );
    } catch { /* skip invalid keys */ }
  }

  cachedCerts = { keys, expiresAt: Date.now() + maxAge * 1000 };
  return keys;
}

function decodeJwtPart(part: string): Record<string, unknown> {
  let b64 = part.replace(/-/g, "+").replace(/_/g, "/");
  while (b64.length % 4) b64 += "=";
  return JSON.parse(atob(b64));
}

async function verifyFirebaseToken(token: string): Promise<boolean> {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return false;

    const header = decodeJwtPart(parts[0]) as { alg?: string; kid?: string };
    const payload = decodeJwtPart(parts[1]) as {
      iss?: string; aud?: string; exp?: number; iat?: number; sub?: string;
    };

    // Check algorithm
    if (header.alg !== "RS256") return false;

    // Check issuer matches a known Firebase project
    const project = FIREBASE_PROJECTS.find(
      (p) => payload.iss === `https://securetoken.google.com/${p}` && payload.aud === p
    );
    if (!project) return false;

    // Check expiry (allow 5 min clock skew)
    const now = Math.floor(Date.now() / 1000);
    if (!payload.exp || payload.exp < now - 300) return false;
    if (!payload.iat || payload.iat > now + 300) return false;
    if (!payload.sub) return false;

    // Verify signature with Google's public key
    const certs = await fetchGoogleCerts();
    const key = header.kid ? certs[header.kid] : undefined;
    if (!key) return false;

    let sigB64 = parts[2].replace(/-/g, "+").replace(/_/g, "/");
    while (sigB64.length % 4) sigB64 += "=";
    const signatureBytes = Uint8Array.from(
      atob(sigB64),
      (c) => c.charCodeAt(0)
    );
    const dataBytes = new TextEncoder().encode(parts[0] + "." + parts[1]);

    return await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, signatureBytes, dataBytes);
  } catch {
    return false;
  }
}

/**
 * Create a DO request URL that preserves the original host but remaps the pathname.
 * This is important for OAuth callbacks where the DO needs to know the public host.
 */
function createDoUrl(req: Request, pathname: string): URL {
  const url = new URL(req.url);
  url.pathname = pathname;
  return url;
}

function withCors(response: Response): Response {
  // Don't wrap WebSocket upgrade responses - they have a webSocket property
  // that gets lost when creating a new Response
  if ((response as any).webSocket) {
    return response;
  }
  
  const newHeaders = new Headers(response.headers);
  for (const [key, value] of Object.entries(CORS_HEADERS)) {
    newHeaders.set(key, value);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: newHeaders,
  });
}

const CF_CONTEXT_KEYS = [
  "colo",
  "country",
  "city",
  "region",
  "timezone",
  "postalCode",
  "asOrganization",
] as const;

type CfRequest = Request & { cf?: Record<string, unknown> };

function buildRequestContext(req: Request): ThreadRequestContext {
  const headers = req.headers;
  const cf = (req as CfRequest).cf ?? undefined;
  const context: ThreadRequestContext = {
    userAgent: headers.get("user-agent") ?? undefined,
    ip: headers.get("cf-connecting-ip") ?? undefined,
    referrer: headers.get("referer") ?? undefined,
    origin: headers.get("origin") ?? undefined,
  };
  if (cf) {
    const filtered: Record<string, unknown> = {};
    for (const key of CF_CONTEXT_KEYS) {
      const value = (cf as Record<string, unknown>)[key];
      if (value !== undefined) filtered[key] = value;
    }
    if (Object.keys(filtered).length > 0) {
      context.cf = filtered;
    }
  }
  return context;
}

const getPlugins = (req: IRequest, { opts }: RequestContext) => {
  return Response.json({
    plugins: opts.plugins || [],
    tools: opts.tools || [],
  });
};


const listAgencies = async (req: IRequest, { env }: RequestContext) => {
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
        // Corrupted or empty .agency.json - use defaults
        agencies.push({ id: agencyName, name: agencyName });
      }
    } else {
      agencies.push({ id: agencyName, name: agencyName });
    }
  }
  return Response.json({ agencies });
};

const createAgency = async (req: IRequest, { env }: RequestContext) => {
  const body = await req.json<{ name?: string }>().catch(() => ({}) as { name?: string });
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
    name: name,
    createdAt: new Date().toISOString(),
  };
  await env.FS.put(`${name}/.agency.json`, JSON.stringify(meta));

  return Response.json(meta, { status: 201 });
};


async function getAgencyStub(agencyId: string, ctx: CfCtx): Promise<DurableObjectStub<Agency>> {
  // Decode in case the agency ID contains slashes (e.g., "owner/repo")
  const decodedId = decodeURIComponent(agencyId);
  return getAgentByName(ctx.exports.Agency, decodedId);
}

/** Check if an agency exists (has been explicitly created via POST /agencies) */
async function agencyExists(agencyId: string, env: HandlerEnv): Promise<boolean> {
  if (!env.FS) return true; // No R2 bucket = skip check
  const metaObj = await env.FS.head(`${agencyId}/.agency.json`);
  return metaObj !== null;
}

/** 
 * Require agency to exist before proceeding. Returns 404 Response if not found.
 * Use in route handlers: const error = await requireAgency(...); if (error) return error;
 */
async function requireAgency(agencyId: string, env: HandlerEnv): Promise<Response | null> {
  const decodedId = decodeURIComponent(agencyId);
  const exists = await agencyExists(decodedId, env);
  if (!exists) {
    return new Response(
      JSON.stringify({ 
        error: "Agency not found",
        message: `Agency '${decodedId}' does not exist. Create it first with POST /agencies`,
        agencyId: decodedId,
      }),
      { status: 404, headers: { "content-type": "application/json" } }
    );
  }
  return null;
}

const deleteAgency = async (req: IRequest, { ctx }: RequestContext) => {
  const agencyStub = await getAgencyStub(req.params.agencyId, ctx);
  return agencyStub.fetch(new Request(createDoUrl(req, "/destroy"), { method: "DELETE" }));
};

const listBlueprints = async (req: IRequest, { ctx, opts }: RequestContext) => {
  const agencyStub = await getAgencyStub(req.params.agencyId, ctx);
  const res = await agencyStub.fetch(new Request(createDoUrl(req, "/blueprints")));
  if (!res.ok) return res;

  const dynamic = await res.json<{ blueprints: AgentBlueprint[] }>();
  const combined = new Map<string, AgentBlueprint>();

  (opts.agentDefinitions || []).forEach((b) => combined.set(b.name, b));
  dynamic.blueprints.forEach((b) => combined.set(b.name, b));

  return Response.json({ blueprints: Array.from(combined.values()) });
};

const createBlueprint = async (req: IRequest, { ctx }: RequestContext) => {
  const agencyStub = await getAgencyStub(req.params.agencyId, ctx);
  return agencyStub.fetch(new Request(createDoUrl(req, "/blueprints"), req));
};

const deleteBlueprint = async (req: IRequest, { ctx }: RequestContext) => {
  const agencyStub = await getAgencyStub(req.params.agencyId, ctx);
  return agencyStub.fetch(
    new Request(createDoUrl(req, `/blueprints/${req.params.blueprintName}`), { method: "DELETE" })
  );
};

const listAgents = async (req: IRequest, { ctx, env }: RequestContext) => {
  const notFound = await requireAgency(req.params.agencyId, env);
  if (notFound) return notFound;
  
  const agencyStub = await getAgencyStub(req.params.agencyId, ctx);
  return agencyStub.fetch(new Request(createDoUrl(req, "/agents")));
};

const createAgent = async (req: IRequest, { ctx, env }: RequestContext) => {
  const notFound = await requireAgency(req.params.agencyId, env);
  if (notFound) return notFound;
  
  const agencyStub = await getAgencyStub(req.params.agencyId, ctx);
  const body = await req.json<Record<string, unknown>>();
  body.requestContext = buildRequestContext(req);

  return agencyStub.fetch(
    new Request(createDoUrl(req, "/agents"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    })
  );
};

const deleteAgent = async (req: IRequest, { ctx }: RequestContext) => {
  const agencyStub = await getAgencyStub(req.params.agencyId, ctx);
  return agencyStub.fetch(
    new Request(createDoUrl(req, `/agents/${req.params.agentId}`), { method: "DELETE" })
  );
};

const getAgentTree = async (req: IRequest, { ctx }: RequestContext) => {
  const agencyStub = await getAgencyStub(req.params.agencyId, ctx);
  return agencyStub.fetch(new Request(createDoUrl(req, `/agents/${req.params.agentId}/tree`)));
};

const getAgentForest = async (req: IRequest, { ctx }: RequestContext) => {
  const agencyStub = await getAgencyStub(req.params.agencyId, ctx);
  return agencyStub.fetch(new Request(createDoUrl(req, "/agents/tree")));
};

const listSchedules = async (req: IRequest, { ctx }: RequestContext) => {
  const agencyStub = await getAgencyStub(req.params.agencyId, ctx);
  return agencyStub.fetch(new Request(createDoUrl(req, "/schedules")));
};

const createSchedule = async (req: IRequest, { ctx }: RequestContext) => {
  const agencyStub = await getAgencyStub(req.params.agencyId, ctx);
  return agencyStub.fetch(
    new Request(createDoUrl(req, "/schedules"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: req.body,
    })
  );
};

const getSchedule = async (req: IRequest, { ctx }: RequestContext) => {
  const agencyStub = await getAgencyStub(req.params.agencyId, ctx);
  return agencyStub.fetch(new Request(createDoUrl(req, `/schedules/${req.params.scheduleId}`)));
};

const updateSchedule = async (req: IRequest, { ctx }: RequestContext) => {
  const agencyStub = await getAgencyStub(req.params.agencyId, ctx);
  return agencyStub.fetch(
    new Request(createDoUrl(req, `/schedules/${req.params.scheduleId}`), {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: req.body,
    })
  );
};

const deleteSchedule = async (req: IRequest, { ctx }: RequestContext) => {
  const agencyStub = await getAgencyStub(req.params.agencyId, ctx);
  return agencyStub.fetch(
    new Request(createDoUrl(req, `/schedules/${req.params.scheduleId}`), { method: "DELETE" })
  );
};

const pauseSchedule = async (req: IRequest, { ctx }: RequestContext) => {
  const agencyStub = await getAgencyStub(req.params.agencyId, ctx);
  return agencyStub.fetch(
    new Request(createDoUrl(req, `/schedules/${req.params.scheduleId}/pause`), { method: "POST" })
  );
};

const resumeSchedule = async (req: IRequest, { ctx }: RequestContext) => {
  const agencyStub = await getAgencyStub(req.params.agencyId, ctx);
  return agencyStub.fetch(
    new Request(createDoUrl(req, `/schedules/${req.params.scheduleId}/resume`), { method: "POST" })
  );
};

const triggerSchedule = async (req: IRequest, { ctx }: RequestContext) => {
  const agencyStub = await getAgencyStub(req.params.agencyId, ctx);
  return agencyStub.fetch(
    new Request(createDoUrl(req, `/schedules/${req.params.scheduleId}/trigger`), { method: "POST" })
  );
};

const getScheduleRuns = async (req: IRequest, { ctx }: RequestContext) => {
  const agencyStub = await getAgencyStub(req.params.agencyId, ctx);
  return agencyStub.fetch(new Request(createDoUrl(req, `/schedules/${req.params.scheduleId}/runs`)));
};

// --- Vars ---

const getVars = async (req: IRequest, { ctx, env }: RequestContext) => {
  const notFound = await requireAgency(req.params.agencyId, env);
  if (notFound) return notFound;
  
  const agencyStub = await getAgencyStub(req.params.agencyId, ctx);
  return agencyStub.fetch(new Request(createDoUrl(req, "/vars")));
};

const setVars = async (req: IRequest, { ctx, env }: RequestContext) => {
  const notFound = await requireAgency(req.params.agencyId, env);
  if (notFound) return notFound;
  
  const agencyStub = await getAgencyStub(req.params.agencyId, ctx);
  return agencyStub.fetch(
    new Request(createDoUrl(req, "/vars"), {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: req.body,
    })
  );
};

const getVar = async (req: IRequest, { ctx, env }: RequestContext) => {
  const notFound = await requireAgency(req.params.agencyId, env);
  if (notFound) return notFound;
  
  const agencyStub = await getAgencyStub(req.params.agencyId, ctx);
  return agencyStub.fetch(new Request(createDoUrl(req, `/vars/${req.params.varKey}`)));
};

const setVar = async (req: IRequest, { ctx, env }: RequestContext) => {
  const notFound = await requireAgency(req.params.agencyId, env);
  if (notFound) return notFound;
  
  const agencyStub = await getAgencyStub(req.params.agencyId, ctx);
  return agencyStub.fetch(
    new Request(createDoUrl(req, `/vars/${req.params.varKey}`), {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: req.body,
    })
  );
};

const deleteVar = async (req: IRequest, { ctx }: RequestContext) => {
  const agencyStub = await getAgencyStub(req.params.agencyId, ctx);
  return agencyStub.fetch(
    new Request(createDoUrl(req, `/vars/${req.params.varKey}`), { method: "DELETE" })
  );
};

// --- MCP Servers ---

const listMcpServers = async (req: IRequest, { ctx }: RequestContext) => {
  const agencyStub = await getAgencyStub(req.params.agencyId, ctx);
  return agencyStub.fetch(new Request(createDoUrl(req, "/mcp")));
};

const addMcpServer = async (req: IRequest, { ctx }: RequestContext) => {
  const agencyStub = await getAgencyStub(req.params.agencyId, ctx);
  return agencyStub.fetch(
    new Request(createDoUrl(req, "/mcp"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: req.body,
    })
  );
};

const removeMcpServer = async (req: IRequest, { ctx }: RequestContext) => {
  const agencyStub = await getAgencyStub(req.params.agencyId, ctx);
  return agencyStub.fetch(
    new Request(createDoUrl(req, `/mcp/${req.params.serverId}`), { method: "DELETE" })
  );
};

const retryMcpServer = async (req: IRequest, { ctx }: RequestContext) => {
  const agencyStub = await getAgencyStub(req.params.agencyId, ctx);
  return agencyStub.fetch(
    new Request(createDoUrl(req, `/mcp/${req.params.serverId}/retry`), { method: "POST" })
  );
};

const listMcpTools = async (req: IRequest, { ctx }: RequestContext) => {
  const agencyStub = await getAgencyStub(req.params.agencyId, ctx);
  return agencyStub.fetch(new Request(createDoUrl(req, "/mcp/tools")));
};

const callMcpTool = async (req: IRequest, { ctx }: RequestContext) => {
  const agencyStub = await getAgencyStub(req.params.agencyId, ctx);
  return agencyStub.fetch(
    new Request(createDoUrl(req, "/mcp/call"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: req.body,
    })
  );
};

const handleFilesystem = async (req: IRequest, { ctx }: RequestContext) => {
  const agencyStub = await getAgencyStub(req.params.agencyId, ctx);
  const fsPath = req.params.path || "";
  return agencyStub.fetch(
    new Request(createDoUrl(req, `/fs/${fsPath}`), {
      method: req.method,
      headers: req.headers,
      body: req.body,
    })
  );
};

const getMetrics = async (req: IRequest, { ctx }: RequestContext) => {
  const agencyStub = await getAgencyStub(req.params.agencyId, ctx);
  return agencyStub.fetch(new Request(createDoUrl(req, "/metrics")));
};

const getPresence = async (req: IRequest, { ctx, env }: RequestContext) => {
  const notFound = await requireAgency(req.params.agencyId, env);
  if (notFound) return notFound;
  const agencyStub = await getAgencyStub(req.params.agencyId, ctx);
  const doUrl = new URL(req.url);
  return agencyStub.fetch(
    new Request(`http://do/presence${doUrl.search}`)
  );
};

const handleAgencyWebSocket = async (req: IRequest, { ctx }: RequestContext) => {
  const agencyStub = await getAgencyStub(req.params.agencyId, ctx);
  return agencyStub.fetch(req);
};

/**
 * Handle MCP OAuth callbacks. Forwards to Agency DO where the SDK handles the OAuth flow.
 */
const handleMcpOAuthCallback = async (req: IRequest, { ctx }: RequestContext) => {
  const agencyStub = await getAgencyStub(req.params.agencyId, ctx);
  return agencyStub.fetch(req);
};

const handleAgentRequest = async (req: IRequest, { ctx }: RequestContext) => {
  const hubAgentStub = await getAgentByName(ctx.exports.HubAgent, req.params.agentId);
  const agentPath = req.params.path || "";

  // WebSocket upgrade — register agent with Agency for presence discovery
  if (req.headers.get("Upgrade")?.toLowerCase() === "websocket") {
    try {
      const agencyStub = await getAgencyStub(req.params.agencyId, ctx);
      await agencyStub.fetch(new Request("http://do/internal/register-agent", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          agentId: req.params.agentId,
          agentType: "co2-assistant",
        }),
      }));
    } catch { /* best-effort — don't block upgrade */ }
    return hubAgentStub.fetch(req);
  }

  const doUrl = new URL(req.url);
  doUrl.pathname = "/" + agentPath;

  let doReq: Request;

  // Special handling for invoke
  if (agentPath === "invoke" && req.method === "POST") {
    const body = await req.json<Record<string, unknown>>();
    body.threadId = req.params.agentId;
    doReq = new Request(doUrl, {
      method: req.method,
      headers: req.headers,
      body: JSON.stringify(body),
    });
  } else {
    doReq = new Request(doUrl, req);
  }

  return hubAgentStub.fetch(doReq);
};

export const createHandler = (opts: HandlerOptions = {}) => {
  const router = Router<IRequest, [RequestContext]>();

  // Plugins
  router.get("/plugins", getPlugins);

  // Agencies
  router.get("/agencies", listAgencies);
  router.post("/agencies", createAgency);

  // Agency - destroy
  router.delete("/agency/:agencyId", deleteAgency);
  router.delete("/agency/:agencyId/destroy", deleteAgency);

  // Blueprints
  router.get("/agency/:agencyId/blueprints", listBlueprints);
  router.post("/agency/:agencyId/blueprints", createBlueprint);
  router.delete("/agency/:agencyId/blueprints/:blueprintName", deleteBlueprint);

  // Agents
  router.get("/agency/:agencyId/agents", listAgents);
  router.get("/agency/:agencyId/agents/tree", getAgentForest);
  router.post("/agency/:agencyId/agents", createAgent);
  router.get("/agency/:agencyId/agents/:agentId/tree", getAgentTree);
  router.delete("/agency/:agencyId/agents/:agentId", deleteAgent);

  // Presence
  router.get("/agency/:agencyId/presence", getPresence);

  // Schedules
  router.get("/agency/:agencyId/schedules", listSchedules);
  router.post("/agency/:agencyId/schedules", createSchedule);
  router.get("/agency/:agencyId/schedules/:scheduleId", getSchedule);
  router.patch("/agency/:agencyId/schedules/:scheduleId", updateSchedule);
  router.delete("/agency/:agencyId/schedules/:scheduleId", deleteSchedule);
  router.post("/agency/:agencyId/schedules/:scheduleId/pause", pauseSchedule);
  router.post("/agency/:agencyId/schedules/:scheduleId/resume", resumeSchedule);
  router.post("/agency/:agencyId/schedules/:scheduleId/trigger", triggerSchedule);
  router.get("/agency/:agencyId/schedules/:scheduleId/runs", getScheduleRuns);

  // Vars
  router.get("/agency/:agencyId/vars", getVars);
  router.put("/agency/:agencyId/vars", setVars);
  router.get("/agency/:agencyId/vars/:varKey", getVar);
  router.put("/agency/:agencyId/vars/:varKey", setVar);
  router.delete("/agency/:agencyId/vars/:varKey", deleteVar);

  // MCP Servers
  router.get("/agency/:agencyId/mcp", listMcpServers);
  router.post("/agency/:agencyId/mcp", addMcpServer);
  router.get("/agency/:agencyId/mcp/tools", listMcpTools);
  router.post("/agency/:agencyId/mcp/call", callMcpTool);
  router.delete("/agency/:agencyId/mcp/:serverId", removeMcpServer);
  router.post("/agency/:agencyId/mcp/:serverId/retry", retryMcpServer);

  // Filesystem (greedy param for path)
  router.all("/agency/:agencyId/fs/:path+", handleFilesystem);
  router.all("/agency/:agencyId/fs", handleFilesystem);

  // Metrics
  router.get("/agency/:agencyId/metrics", getMetrics);

  // Agency WebSocket (for UI event subscriptions)
  router.get("/agency/:agencyId/ws", handleAgencyWebSocket);

  // Agent (greedy param for agent routes)
  router.all("/agency/:agencyId/agent/:agentId/:path+", handleAgentRequest);
  router.all("/agency/:agencyId/agent/:agentId", handleAgentRequest);

  // MCP OAuth callbacks
  router.get("/oauth/agency/:agencyId/callback", handleMcpOAuthCallback);

  // Admin API — D1-backed cross-agent queries
  router.get("/admin/api/activity", async (req: IRequest, { env }: RequestContext) => {
    const db = (env as any).ADMIN_DB;
    if (!db) return Response.json({ error: "ADMIN_DB not configured", agents: [] });
    const url = new URL(req.url);
    const q = url.searchParams.get("q")?.trim();
    let results;
    if (q) {
      const like = `%${q}%`;
      ({ results } = await db.prepare(
        "SELECT * FROM agent_activity WHERE agent_id LIKE ? OR agency_id LIKE ? OR agent_type LIKE ? OR user_id LIKE ? OR estate_id LIKE ? OR last_prompt LIKE ? ORDER BY last_active_at DESC LIMIT 100"
      ).bind(like, like, like, like, like, like).all());
    } else {
      ({ results } = await db.prepare(
        "SELECT * FROM agent_activity ORDER BY last_active_at DESC LIMIT 100"
      ).all());
    }
    return Response.json({ agents: results, count: results.length });
  });

  router.get("/admin/api/stats", async (_req: IRequest, { env }: RequestContext) => {
    const db = (env as any).ADMIN_DB;
    if (!db) return Response.json({ error: "ADMIN_DB not configured" });
    const { results } = await db.prepare(`
      SELECT
        COUNT(*) as total_agents,
        SUM(message_count) as total_messages,
        SUM(memory_count) as total_memories,
        SUM(run_count) as total_runs,
        COUNT(CASE WHEN last_active_at > ? THEN 1 END) as active_24h,
        MAX(last_active_at) as latest_active_at
      FROM agent_activity
    `).bind(Date.now() - 86400000).all();
    return Response.json(results[0] || {});
  });

  router.post("/admin/api/activity", async (req: IRequest, { env }: RequestContext) => {
    const db = (env as any).ADMIN_DB;
    if (!db) return Response.json({ error: "ADMIN_DB not configured" });
    const body = await req.json() as any;
    await db.prepare(`
      INSERT INTO agent_activity (agent_id, agency_id, agent_type, message_count, memory_count, run_count, last_active_at, updated_at, user_id, estate_id, last_prompt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(agency_id, agent_id) DO UPDATE SET
        agent_type = excluded.agent_type,
        message_count = CASE WHEN excluded.message_count > 0 THEN excluded.message_count ELSE message_count END,
        memory_count = CASE WHEN excluded.memory_count > 0 THEN excluded.memory_count ELSE memory_count END,
        run_count = CASE WHEN excluded.run_count > 0 THEN excluded.run_count ELSE run_count END,
        last_active_at = excluded.last_active_at,
        updated_at = excluded.updated_at,
        user_id = COALESCE(excluded.user_id, user_id),
        estate_id = COALESCE(excluded.estate_id, estate_id),
        last_prompt = COALESCE(excluded.last_prompt, last_prompt)
    `).bind(
      body.agent_id, body.agency_id, body.agent_type || null,
      body.message_count || 0, body.memory_count || 0, body.run_count || 0,
      body.last_active_at || Date.now(), Date.now(),
      body.user_id || null, body.estate_id || null, body.last_prompt || null
    ).run();
    return Response.json({ ok: true });
  });

  // Admin backfill — scan all agents and populate D1 index in one shot
  router.post("/admin/api/backfill", async (_req: IRequest, { env, ctx: cfCtx }: RequestContext) => {
    const db = (env as any).ADMIN_DB;
    if (!db) return Response.json({ error: "ADMIN_DB not configured" });

    const agencyDO = (env as any).AGENCY;
    if (!agencyDO) return Response.json({ error: "No AGENCY binding" });

    // List agencies via the router itself (internal fetch)
    const agenciesRes = await listAgencies(
      { url: "http://internal/agencies", method: "GET", headers: new Headers() } as any,
      { env: env as any, ctx: cfCtx, opts: {} as any }
    );
    const agencies = ((await agenciesRes.json()) as any).agencies || [];

    let indexed = 0;
    let errors = 0;

    for (const ag of agencies) {
      const agId = ag.id || ag.name;
      try {
        const agentsRes = await listAgents(
          { params: { agencyId: agId }, url: `http://internal/agency/${agId}/agents`, method: "GET", headers: new Headers() } as any,
          { env: env as any, ctx: cfCtx, opts: {} as any }
        );
        const agents = ((await agentsRes.json()) as any).agents || [];

        // Batch upsert in chunks of 20
        for (let i = 0; i < agents.length; i += 20) {
          const batch = agents.slice(i, i + 20);
          const stmts = batch.map((a: any) => {
            const agentId = a.id || a.name;
            const createdAt = a.createdAt ? new Date(a.createdAt).getTime() : Date.now();
            return db.prepare(
              `INSERT INTO agent_activity (agent_id, agency_id, agent_type, message_count, memory_count, run_count, last_active_at, updated_at)
               VALUES (?, ?, ?, 0, 0, 0, ?, ?)
               ON CONFLICT(agency_id, agent_id) DO UPDATE SET
                 agent_type = excluded.agent_type,
                 updated_at = excluded.updated_at`
            ).bind(agentId, agId, a.agentType || null, createdAt, Date.now());
          });
          await db.batch(stmts);
          indexed += batch.length;
        }
      } catch (e) {
        errors++;
      }
    }

    return Response.json({ indexed, errors, agencies: agencies.length });
  });

  // Admin chat — natural language queries against the D1 index
  router.post("/admin/api/chat", async (req: IRequest, { env }: RequestContext) => {
    const db = (env as any).ADMIN_DB;
    if (!db) return Response.json({ error: "ADMIN_DB not configured" });

    const { question } = await req.json() as { question: string };
    if (!question) return Response.json({ error: "question required" });

    // Build a SQL query from the question using a simple prompt
    const systemPrompt = `You are a SQL assistant for an agent activity database. The table is:

agent_activity(agent_id TEXT, agency_id TEXT, agent_type TEXT, message_count INT, memory_count INT, run_count INT, last_active_at INT (unix ms), updated_at INT, user_id TEXT, estate_id TEXT, last_prompt TEXT)

Given a natural language question, respond with ONLY a JSON object: {"sql": "SELECT ...", "description": "one line explanation"}

Rules:
- Use SQLite syntax
- LIMIT 20 max
- Only SELECT queries (no mutations)
- last_active_at and updated_at are unix milliseconds
- For "yesterday" use: last_active_at > (strftime('%s','now','-1 day') * 1000)
- For "today" use: last_active_at > (strftime('%s','now','start of day') * 1000)`;

    try {
      // Use the hub's own LLM to generate SQL
      const llmBase = process.env.LLM_API_BASE || "https://openrouter.ai/api/v1";
      const llmKey = process.env.LLM_API_KEY || "";
      const model = "google/gemini-2.0-flash-lite-001";

      const llmRes = await fetch(llmBase + "/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": "Bearer " + llmKey },
        body: JSON.stringify({
          model,
          max_tokens: 256,
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: question },
          ],
        }),
      });
      const llmData = await llmRes.json() as any;
      const content = llmData.choices?.[0]?.message?.content || "";

      // Parse the JSON from the LLM response
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (!jsonMatch) return Response.json({ error: "Could not parse LLM response", raw: content });

      const parsed = JSON.parse(jsonMatch[0]) as { sql: string; description: string };
      if (!parsed.sql || !parsed.sql.toUpperCase().startsWith("SELECT")) {
        return Response.json({ error: "Invalid query", raw: content });
      }

      // Execute the SQL
      const { results } = await db.prepare(parsed.sql).all();
      return Response.json({ sql: parsed.sql, description: parsed.description, results, count: results.length });
    } catch (e: any) {
      return Response.json({ error: e.message });
    }
  });

  // Admin UI — served from ADMIN_HTML constant (see admin-ui.ts)
  // Debug endpoint — verify a Firebase token and return diagnostics
  router.get("/admin/debug-token", async (req: IRequest) => {
    const authHeader = req.headers.get("Authorization") || "";
    if (!authHeader.startsWith("Bearer ")) {
      return Response.json({ error: "No Bearer token", headers: Object.fromEntries(req.headers.entries()) });
    }
    const token = authHeader.slice(7);
    const parts = token.split(".");
    if (parts.length !== 3) return Response.json({ error: "Not 3 parts", partCount: parts.length });

    try {
      const header = decodeJwtPart(parts[0]);
      const payload = decodeJwtPart(parts[1]);
      const project = FIREBASE_PROJECTS.find(
        (p) => payload.iss === `https://securetoken.google.com/${p}` && payload.aud === p
      );
      const now = Math.floor(Date.now() / 1000);
      const certs = await fetchGoogleCerts();
      const key = header.kid ? certs[header.kid as string] : undefined;

      let sigValid = false;
      if (key) {
        let sigB64 = parts[2].replace(/-/g, "+").replace(/_/g, "/");
        while (sigB64.length % 4) sigB64 += "=";
        const sigBytes = Uint8Array.from(atob(sigB64), (c) => c.charCodeAt(0));
        const dataBytes = new TextEncoder().encode(parts[0] + "." + parts[1]);
        sigValid = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, sigBytes, dataBytes);
      }

      return Response.json({
        header,
        issuer: payload.iss,
        audience: payload.aud,
        subject: payload.sub,
        email: (payload as any).email,
        exp: payload.exp,
        iat: payload.iat,
        now,
        expired: payload.exp ? payload.exp < now - 300 : "no exp",
        projectMatch: project || null,
        kidMatch: !!key,
        certCount: Object.keys(certs).length,
        availableKids: Object.keys(certs),
        signatureValid: sigValid,
        wouldAuth: !!(project && sigValid && payload.exp && payload.exp >= now - 300),
      });
    } catch (e: any) {
      return Response.json({ error: e.message, stack: e.stack });
    }
  });

  router.get("/admin", () => new Response(ADMIN_HTML, {
    headers: { "Content-Type": "text/html; charset=utf-8" },
  }));

  // 404
  router.all("*", () => new Response("Not found", { status: 404 }));

  return {
    async fetch(req: Request, env: HandlerEnv, ctx: CfCtx) {
      const url = new URL(req.url);

      // CORS preflight
      if (req.method === "OPTIONS") {
        return new Response(null, { status: 204, headers: CORS_HEADERS });
      }

      // Auth check — accepts either:
      // 1. X-SECRET header or ?key= query param (legacy, machine-to-machine)
      // 2. Authorization: Bearer <firebase-id-token> (user sign-in from admin UI)
      // Skip for OAuth callbacks and the /admin page itself (serves static HTML)
      const isOAuthCallback = /^\/oauth\/agency\/[^/]+\/callback$/.test(url.pathname) && url.searchParams.has("state");
      const isAdminPage = url.pathname.startsWith("/admin");
      const providedSecret = req.headers.get("X-SECRET") || url.searchParams.get("key");
      const secret = process.env.SECRET;

      let authed = !secret || isOAuthCallback || isAdminPage;

      // Check legacy secret
      if (!authed && providedSecret && secureCompare(providedSecret, secret)) {
        authed = true;
      }

      // Check Firebase ID token
      if (!authed) {
        const authHeader = req.headers.get("Authorization") || "";
        if (authHeader.startsWith("Bearer ")) {
          const token = authHeader.slice(7);
          const verified = await verifyFirebaseToken(token);
          if (verified) authed = true;
        }
      }

      if (!authed) {
        if (req.headers.get("Upgrade")?.toLowerCase() === "websocket") {
          return withCors(new Response("Unauthorized", { status: 401 }));
        }
        const path = url.pathname;
        if (
          path.startsWith("/api") ||
          path.startsWith("/agency") ||
          path.startsWith("/agencies") ||
          path.startsWith("/plugins")
        ) {
          return withCors(new Response("Unauthorized", { status: 401 }));
        }
        return new Response(
          "Forbidden: Please provide ?key=YOUR_SECRET or sign in with your CO2 account",
          { status: 403 }
        );
      }

      // Route the request
      const response = await router.fetch(req, { env, ctx, opts });
      return withCors(response);
    },
  };
};
