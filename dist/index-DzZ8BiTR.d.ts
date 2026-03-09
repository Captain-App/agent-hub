import { d as AgentPlugin } from './types-DktRH7PR.js';

/**
 * Resolves `$VAR_NAME` patterns in tool arguments using agent vars.
 * Supports both string interpolation and full-value replacement.
 */
declare const vars: AgentPlugin;

/**
 * Logs all agent events to console for debugging and observability.
 */
declare const logger: AgentPlugin;

/**
 * Human-in-the-Loop plugin that pauses the agent when risky tools are called,
 * allowing human approval before execution.
 *
 * Configure which tools require approval via the `HITL_TOOLS` var (string[]).
 */
declare const hitl: AgentPlugin;

type Todo = {
    content: string;
    status: "pending" | "in_progress" | "completed";
};
/**
 * Provides task planning and todo management for agents handling complex multi-step tasks.
 * Stores todos in SQLite and exposes them via agent state.
 */
declare const planning: AgentPlugin;

/**
 * Context management plugin that automatically summarizes long conversations.
 *
 * When the message count exceeds CONTEXT_SUMMARIZE_AT, older messages are
 * summarized using an LLM call, archived to the filesystem, and deleted
 * from the active context. The summary is prepended to future requests.
 *
 * Optionally extracts important facts as "memories" and stores them to
 * a memory disk for long-term retrieval.
 *
 * @var CONTEXT_KEEP_RECENT - Messages to keep in full (default: 20)
 * @var CONTEXT_SUMMARIZE_AT - Trigger summarization threshold (default: 40)
 * @var CONTEXT_MEMORY_DISK - Optional disk name for extracted memories
 * @var CONTEXT_SUMMARY_MODEL - Optional model for summarization
 */
declare const context: AgentPlugin;

declare const subagents: AgentPlugin;

declare const subagentReporter: AgentPlugin;

type index_Todo = Todo;
declare const index_context: typeof context;
declare const index_hitl: typeof hitl;
declare const index_logger: typeof logger;
declare const index_planning: typeof planning;
declare const index_subagentReporter: typeof subagentReporter;
declare const index_subagents: typeof subagents;
declare const index_vars: typeof vars;
declare namespace index {
  export { type index_Todo as Todo, index_context as context, index_hitl as hitl, index_logger as logger, index_planning as planning, index_subagentReporter as subagentReporter, index_subagents as subagents, index_vars as vars };
}

export { type Todo as T, subagentReporter as a, context as c, hitl as h, index as i, logger as l, planning as p, subagents as s, vars as v };
