import { SELF, fetchMock } from "cloudflare:test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Real RS256 tokens, signed by a key the test serves as Google's JWKS, so the
// worker runs its full verification path.
const KID = "access-test-kid";
const PROJECT = "co2-target-asset-tracking"; // what http://localhost expects
let signingKey: CryptoKey;

const b64url = (bytes: Uint8Array | string) => {
  const raw = typeof bytes === "string" ? bytes : String.fromCharCode(...bytes);
  return btoa(raw).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

async function token(sub: string, roles: string[] = [], aud = PROJECT): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const head = b64url(JSON.stringify({ alg: "RS256", kid: KID, typ: "JWT" }));
  const body = b64url(JSON.stringify({
    iss: `https://securetoken.google.com/${aud}`, aud, sub, iat: now, exp: now + 3600, roles,
  }));
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", signingKey, new TextEncoder().encode(`${head}.${body}`));
  return `${head}.${body}.${b64url(new Uint8Array(sig))}`;
}

beforeAll(async () => {
  const pair = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true, ["sign", "verify"]) as CryptoKeyPair;
  signingKey = pair.privateKey;
  const jwk = await crypto.subtle.exportKey("jwk", pair.publicKey) as JsonWebKey;
  // The test files share one isolate: mock only Google's JWKS and let every other fetch through.
  fetchMock.activate();
  fetchMock.enableNetConnect();
  fetchMock.get("https://www.googleapis.com")
    .intercept({ path: "/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com" })
    .reply(200, JSON.stringify({ keys: [{ kid: KID, kty: jwk.kty, n: jwk.n, e: jwk.e, alg: "RS256" }] }),
      { headers: { "content-type": "application/json", "cache-control": "max-age=3600" } })
    .persist();
});

afterAll(() => fetchMock.deactivate());

function action(agent: string, type: string | undefined, auth: Record<string, string>, extra: object = {}) {
  return SELF.fetch(`http://localhost/agency/default/agent/${agent}/action`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...auth },
    body: JSON.stringify({ ...(type === undefined ? {} : { type }), ...extra }),
  });
}

const SECRET = { "X-SECRET": "shared-app-secret" };
const bearer = (t: string) => ({ Authorization: `Bearer ${t}`, ...SECRET });

describe("agent actions are denied by default", () => {
  it("a non-god token can't refresh another user's tabs", async () => {
    const attacker = await token("attackeruid");
    const response = await action("co2-assistant-victimuid", "devRefreshRequest", bearer(attacker));
    expect(response.status).toBe(403);
  });

  it.each(["devRefreshRequest", "forceNavigate", "devScreenshotRequest", "browseMemories", "reset", "cancel", "someFutureAction"])(
    "the shared secret alone can't call %s", async (type) => {
      const response = await action("co2-assistant-victimuid", type, SECRET, { route: "/x", requestId: "r" });
      expect(response.status).toBe(403);
    });

  it("a body without a type is refused", async () => {
    expect((await action("co2-assistant-victimuid", undefined, SECRET)).status).toBe(403);
  });

  it("a token for another Firebase project is refused", async () => {
    const devToken = await token("victimuid", ["god"], "co2-target-asset-tracking-dev");
    expect((await action("co2-assistant-victimuid", "forceNavigate", bearer(devToken), { route: "/x" })).status).toBe(403);
  });

  it("a user may navigate their own tabs", async () => {
    const own = await token("owneruid");
    const response = await action("co2-assistant-owneruid", "forceNavigate", bearer(own), { route: "/estates" });
    expect(response.status).toBe(200);
  });

  it("a user can't use the operator reads, even on their own agent", async () => {
    const own = await token("owneruid");
    const response = await action("co2-assistant-owneruid", "readClientContext", bearer(own), { clientSessionId: "0123456789abcdef" });
    expect(response.status).toBe(403);
  });

  it("god may navigate anyone's tabs", async () => {
    const god = await token("operatoruid", ["god"]);
    const response = await action("co2-assistant-victimuid", "forceNavigate", bearer(god), { route: "/estates" });
    expect(response.status).toBe(200);
  });

  it("a client answer still passes on the secret alone", async () => {
    // Reaches the agent, which has no pending call: not the guard's 403.
    const response = await action("co2-assistant-victimuid", "clientToolResponse", SECRET, { callId: "none" });
    expect(response.status).not.toBe(403);
  });
});

describe("the admin API needs god", () => {
  const routes: Array<[string, string]> = [
    ["GET", "/admin/api/activity"],
    ["GET", "/admin/api/stats"],
    ["POST", "/admin/api/activity"],
    ["POST", "/admin/api/chat"],
    ["POST", "/admin/api/export/default/co2-assistant-victimuid"],
    ["POST", "/admin/api/backup"],
    ["POST", "/admin/api/backfill"],
    ["GET", "/admin/api/backups"],
    ["GET", "/admin/debug-token"],
  ];

  it.each(routes)("%s %s refuses no credentials and the secret", async (method, path) => {
    for (const headers of [{}, SECRET]) {
      const response = await SELF.fetch(`http://localhost${path}`, { method, headers, body: method === "POST" ? "{}" : undefined });
      expect(response.status).toBe(401);
    }
  });

  it.each(routes)("%s %s refuses a non-god token", async (method, path) => {
    const user = await token("someuid");
    const response = await SELF.fetch(`http://localhost${path}`, { method, headers: bearer(user), body: method === "POST" ? "{}" : undefined });
    expect(response.status).toBe(403);
  });

  it("god reads the admin API", async () => {
    const god = await token("operatoruid", ["god"]);
    const response = await SELF.fetch("http://localhost/admin/api/stats", { headers: bearer(god) });
    expect(response.status).toBe(200);
  });

  it("the admin page itself stays a public redirect", async () => {
    const response = await SELF.fetch("http://localhost/admin", { redirect: "manual" });
    expect(response.status).toBe(302);
  });
});
