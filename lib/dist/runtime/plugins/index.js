import { zodToJsonSchema } from 'zod-to-json-schema';
import { z } from 'zod';
import { getAgentByName } from 'agents';

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

// runtime/config.ts
var DEFAULT_CONTEXT_KEEP_RECENT = 20;
var DEFAULT_CONTEXT_SUMMARIZE_AT = 40;

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

export { context, hitl, logger, planning, subagentReporter, subagents, vars };
//# sourceMappingURL=index.js.map
//# sourceMappingURL=index.js.map