// client/index.ts
var AgentHubError = class extends Error {
  constructor(message, status, body) {
    super(message);
    this.status = status;
    this.body = body;
    this.name = "AgentHubError";
  }
};
var AgentClient = class {
  constructor(baseUrl, agencyId, agentId, headers, fetchFn) {
    this.baseUrl = baseUrl;
    this.agencyId = agencyId;
    this.agentId = agentId;
    this.headers = headers;
    this.fetchFn = fetchFn;
  }
  get path() {
    return `${this.baseUrl}/agency/${this.agencyId}/agent/${this.agentId}`;
  }
  async request(method, endpoint, body) {
    const url = `${this.path}${endpoint}`;
    const res = await this.fetchFn(url, {
      method,
      headers: {
        ...this.headers,
        ...body ? { "Content-Type": "application/json" } : {}
      },
      body: body ? JSON.stringify(body) : void 0
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new AgentHubError(
        `Request failed: ${res.status} ${res.statusText}`,
        res.status,
        text
      );
    }
    return res.json();
  }
  async getState() {
    return this.request("GET", "/state");
  }
  async getEvents() {
    return this.request("GET", "/events");
  }
  async invoke(request = {}) {
    return this.request("POST", "/invoke", request);
  }
  async action(type, payload = {}) {
    return this.request("POST", "/action", { type, ...payload });
  }
  connect(options = {}) {
    const secret = this.headers["X-SECRET"];
    const secretParam = secret ? `?key=${encodeURIComponent(secret)}` : "";
    const wsUrl = this.path.replace(/^http/, "ws").replace(/^wss:\/\/localhost/, "ws://localhost") + secretParam;
    const ws = new WebSocket(wsUrl, options.protocols);
    ws.onopen = () => options.onOpen?.();
    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        options.onEvent?.(data);
      } catch {
      }
    };
    ws.onclose = (event) => options.onClose?.(event);
    ws.onerror = (event) => options.onError?.(event);
    return {
      ws,
      send: (message) => ws.send(JSON.stringify(message)),
      close: () => ws.close()
    };
  }
  get id() {
    return this.agentId;
  }
};
var AgencyClient = class {
  constructor(baseUrl, agencyId, headers, fetchFn) {
    this.baseUrl = baseUrl;
    this.agencyId = agencyId;
    this.headers = headers;
    this.fetchFn = fetchFn;
  }
  get path() {
    return `${this.baseUrl}/agency/${encodeURIComponent(this.agencyId)}`;
  }
  async request(method, endpoint, body) {
    const url = `${this.path}${endpoint}`;
    const res = await this.fetchFn(url, {
      method,
      headers: {
        ...this.headers,
        ...body ? { "Content-Type": "application/json" } : {}
      },
      body: body ? JSON.stringify(body) : void 0
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new AgentHubError(
        `Request failed: ${res.status} ${res.statusText}`,
        res.status,
        text
      );
    }
    return res.json();
  }
  async listBlueprints() {
    return this.request("GET", "/blueprints");
  }
  async createBlueprint(blueprint) {
    return this.request(
      "POST",
      "/blueprints",
      blueprint
    );
  }
  async deleteBlueprint(name) {
    return this.request("DELETE", `/blueprints/${name}`);
  }
  async listAgents() {
    return this.request("GET", "/agents");
  }
  async spawnAgent(request) {
    return this.request("POST", "/agents", request);
  }
  async deleteAgent(agentId) {
    return this.request("DELETE", `/agents/${agentId}`);
  }
  async getAgentTree(agentId) {
    return this.request("GET", `/agents/${agentId}/tree`);
  }
  async getAgentForest() {
    return this.request("GET", "/agents/tree");
  }
  agent(agentId) {
    return new AgentClient(
      this.baseUrl,
      this.agencyId,
      agentId,
      this.headers,
      this.fetchFn
    );
  }
  async listSchedules() {
    return this.request("GET", "/schedules");
  }
  async createSchedule(request) {
    return this.request("POST", "/schedules", request);
  }
  async getSchedule(scheduleId) {
    return this.request("GET", `/schedules/${scheduleId}`);
  }
  async updateSchedule(scheduleId, request) {
    return this.request(
      "PATCH",
      `/schedules/${scheduleId}`,
      request
    );
  }
  async deleteSchedule(scheduleId) {
    return this.request("DELETE", `/schedules/${scheduleId}`);
  }
  async pauseSchedule(scheduleId) {
    return this.request(
      "POST",
      `/schedules/${scheduleId}/pause`
    );
  }
  async resumeSchedule(scheduleId) {
    return this.request(
      "POST",
      `/schedules/${scheduleId}/resume`
    );
  }
  async triggerSchedule(scheduleId) {
    return this.request(
      "POST",
      `/schedules/${scheduleId}/trigger`
    );
  }
  async getScheduleRuns(scheduleId) {
    return this.request(
      "GET",
      `/schedules/${scheduleId}/runs`
    );
  }
  async listDirectory(path = "/") {
    const fsPath = path.startsWith("/") ? path.slice(1) : path;
    const url = `${this.path}/fs/${fsPath}`;
    const res = await this.fetchFn(url, {
      method: "GET",
      headers: this.headers
    });
    if (!res.ok) {
      const text2 = await res.text().catch(() => "");
      throw new AgentHubError(
        `Failed to list directory: ${res.status} ${res.statusText}`,
        res.status,
        text2
      );
    }
    const contentType = res.headers.get("content-type") || "";
    const fsPathHeader = res.headers.get("x-fs-path");
    if (fsPathHeader || contentType.includes("text/plain") && !contentType.includes("json")) {
      throw new AgentHubError("Path is a file, not a directory", 400, "");
    }
    const text = await res.text();
    try {
      return JSON.parse(text);
    } catch {
      throw new AgentHubError("Path is a file, not a directory", 400, "");
    }
  }
  async readFile(path) {
    const fsPath = path.startsWith("/") ? path.slice(1) : path;
    const url = `${this.path}/fs/${fsPath}`;
    const res = await this.fetchFn(url, {
      method: "GET",
      headers: this.headers
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new AgentHubError(
        `Failed to read file: ${res.status} ${res.statusText}`,
        res.status,
        text
      );
    }
    const contentType = res.headers.get("content-type") || "";
    const fsPathHeader = res.headers.get("x-fs-path");
    const content = await res.text();
    if (fsPathHeader) {
      return {
        content,
        path: fsPathHeader,
        size: parseInt(
          res.headers.get("x-fs-size") || String(content.length),
          10
        ),
        modified: res.headers.get("x-fs-modified") || ""
      };
    }
    if (contentType.includes("text/plain") && !contentType.includes("json")) {
      return {
        content,
        path: "/" + fsPath,
        size: content.length,
        modified: ""
      };
    }
    const trimmed = content.trim();
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      try {
        JSON.parse(content);
        throw new AgentHubError("Path is a directory, not a file", 400, "");
      } catch (e) {
        if (e instanceof AgentHubError) throw e;
      }
    }
    return {
      content,
      path: "/" + fsPath,
      size: content.length,
      modified: ""
    };
  }
  async writeFile(path, content) {
    const fsPath = path.startsWith("/") ? path.slice(1) : path;
    const url = `${this.path}/fs/${fsPath}`;
    const res = await this.fetchFn(url, {
      method: "PUT",
      headers: {
        ...this.headers,
        "Content-Type": "text/plain"
      },
      body: content
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new AgentHubError(
        `Failed to write file: ${res.status} ${res.statusText}`,
        res.status,
        text
      );
    }
    return res.json();
  }
  async deleteFile(path) {
    const fsPath = path.startsWith("/") ? path.slice(1) : path;
    const url = `${this.path}/fs/${fsPath}`;
    const res = await this.fetchFn(url, {
      method: "DELETE",
      headers: this.headers
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new AgentHubError(
        `Failed to delete file: ${res.status} ${res.statusText}`,
        res.status,
        text
      );
    }
    return res.json();
  }
  async getVars() {
    return this.request("GET", "/vars");
  }
  async setVars(vars) {
    return this.request("PUT", "/vars", vars);
  }
  async getVar(key) {
    return this.request("GET", `/vars/${encodeURIComponent(key)}`);
  }
  async setVar(key, value) {
    return this.request("PUT", `/vars/${encodeURIComponent(key)}`, { value });
  }
  async deleteVar(key) {
    return this.request("DELETE", `/vars/${encodeURIComponent(key)}`);
  }
  // MCP Server methods
  async listMcpServers() {
    return this.request("GET", "/mcp");
  }
  async addMcpServer(request) {
    return this.request("POST", "/mcp", request);
  }
  async removeMcpServer(serverId) {
    return this.request("DELETE", `/mcp/${serverId}`);
  }
  async retryMcpServer(serverId) {
    return this.request("POST", `/mcp/${serverId}/retry`);
  }
  async listMcpTools() {
    return this.request("GET", "/mcp/tools");
  }
  async deleteAgency() {
    return this.request("DELETE", "/destroy");
  }
  /**
   * Get aggregated metrics for this agency.
   * Returns counts and stats for agents, schedules, and recent runs.
   */
  async getMetrics() {
    return this.request("GET", "/metrics");
  }
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
  connect(options = {}) {
    const secret = this.headers["X-SECRET"];
    const secretParam = secret ? `?key=${encodeURIComponent(secret)}` : "";
    const wsUrl = `${this.path}/ws`.replace(/^http/, "ws").replace(/^wss:\/\/localhost/, "ws://localhost") + secretParam;
    const ws = new WebSocket(wsUrl, options.protocols);
    ws.onopen = () => options.onOpen?.();
    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        options.onEvent?.(data);
      } catch {
      }
    };
    ws.onclose = (event) => options.onClose?.(event);
    ws.onerror = (event) => options.onError?.(event);
    return {
      ws,
      send: (message) => ws.send(JSON.stringify(message)),
      close: () => ws.close(),
      subscribe: (agentIds) => {
        const msg = { type: "subscribe", agentIds };
        ws.send(JSON.stringify(msg));
      },
      unsubscribe: () => {
        const msg = { type: "unsubscribe" };
        ws.send(JSON.stringify(msg));
      }
    };
  }
  get id() {
    return this.agencyId;
  }
};
var AgentHubClient = class {
  constructor(options) {
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.headers = {};
    if (options.secret) {
      this.headers["X-SECRET"] = options.secret;
    }
    this.fetchFn = options.fetch ?? globalThis.fetch.bind(globalThis);
  }
  async request(method, endpoint, body) {
    const url = `${this.baseUrl}${endpoint}`;
    const res = await this.fetchFn(url, {
      method,
      headers: {
        ...this.headers,
        ...body ? { "Content-Type": "application/json" } : {}
      },
      body: body ? JSON.stringify(body) : void 0
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new AgentHubError(
        `Request failed: ${res.status} ${res.statusText}`,
        res.status,
        text
      );
    }
    return res.json();
  }
  async listAgencies() {
    return this.request("GET", "/agencies");
  }
  async getPlugins() {
    return this.request("GET", "/plugins");
  }
  async createAgency(request = {}) {
    return this.request("POST", "/agencies", request);
  }
  async deleteAgency(agencyId) {
    return this.agency(agencyId).deleteAgency();
  }
  agency(agencyId) {
    return new AgencyClient(this.baseUrl, agencyId, this.headers, this.fetchFn);
  }
};

export { AgencyClient, AgentClient, AgentHubClient, AgentHubError };
//# sourceMappingURL=index.js.map
//# sourceMappingURL=index.js.map