/**
 * Who may call an agent action, and who may use the admin API.
 *
 * The shared app secret ships in every web build, so it is public. It proves
 * nothing about the caller. An action is therefore denied unless one of these
 * holds:
 *
 * - its name is in SECRET_CALLABLE_ACTIONS, which lists the few actions that are
 *   harmless when anyone names any agent;
 * - the caller holds a verified Firebase token with the god role;
 * - the caller holds a verified Firebase token for the user who owns the agent,
 *   and the action is not in GOD_ONLY_ACTIONS.
 *
 * A new action is denied to the secret by default. To open one, add it to
 * SECRET_CALLABLE_ACTIONS and say why it is safe there.
 */

/** Claims of a Firebase ID token whose signature, issuer and expiry are already verified. */
export type VerifiedClaims = { aud?: string; sub?: string; roles?: unknown; [key: string]: unknown };

/**
 * Actions the shared secret alone may call. Each one only completes a request
 * the hub itself started, and needs an id the hub chose at random.
 */
export const SECRET_CALLABLE_ACTIONS: ReadonlySet<string> = new Set([
  // Completes a pending client tool call by its random call id. An addressed call also checks
  // the answering connection and session.
  "clientToolResponse",
  // Completes a pending screenshot by its random request id.
  "devScreenshotResponse",
  // Completes a pending CLI tool call by its random call id.
  "cliDomainToolResponse",
  // Completes a waiting subagent by its random token.
  "subagent_result",
]);

/**
 * Actions that reach into a device's live tab beyond what its own user can ask
 * the assistant for. Only god may call them, even on the caller's own agent.
 */
export const GOD_ONLY_ACTIONS: ReadonlySet<string> = new Set([
  "readClientDiagnostics",
  "readClientTelemetry",
  "readClientContext",
  "executeClientAction",
  "captureClientScreenshot",
  "listClientSessions",
]);

const OWNED_AGENT_PREFIXES = ["co2-assistant-", "co2-admin-assistant-"];

/** The Firebase project a hub host serves. */
export function expectedFirebaseProject(hostname: string): string {
  return hostname.startsWith("dev.") || hostname.includes("-dev.")
    ? "co2-target-asset-tracking-dev"
    : "co2-target-asset-tracking";
}

/** True when the agent is the conversation of the user with this uid. */
export function ownsAgent(uid: unknown, agentId: string): boolean {
  return typeof uid === "string" && uid.length > 0 &&
    OWNED_AGENT_PREFIXES.some(prefix => agentId === prefix + uid || agentId.startsWith(prefix + uid + "-"));
}

/** True when verified claims carry the god role for this hub's project. */
export function isGod(claims: VerifiedClaims | null, project: string): boolean {
  return !!claims && claims.aud === project && Array.isArray(claims.roles) && claims.roles.includes("god");
}

/**
 * Decide an agent action. `claims` are the verified Firebase claims of the
 * caller's bearer token, or null when there is no valid token.
 */
export function mayCallAction(
  type: unknown,
  agentId: string,
  claims: VerifiedClaims | null,
  project: string,
): boolean {
  if (typeof type !== "string" || type.length === 0) return false;
  if (SECRET_CALLABLE_ACTIONS.has(type)) return true;
  if (!claims || claims.aud !== project) return false;
  if (isGod(claims, project)) return true;
  if (GOD_ONLY_ACTIONS.has(type)) return false;
  return ownsAgent(claims.sub, agentId);
}

/**
 * The admin page itself is a public redirect. Everything else under /admin
 * (the admin API and its debug routes) needs god.
 */
export function isPublicAdminPage(method: string, pathname: string): boolean {
  return method === "GET" && (pathname === "/admin" || pathname === "/admin/");
}

export function isAdminSurface(pathname: string): boolean {
  return pathname === "/admin" || pathname.startsWith("/admin/");
}
