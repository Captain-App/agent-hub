import { z } from "zod";
import type { ToolContext, ToolJsonSchema, Tool } from "./types";

export type ToolResult = string | object | null;

/** Structural type for Zod schemas (works with both v3 and v4) */
interface ZodSchema<T = unknown> {
  _def: unknown;
  parse: (data: unknown) => T;
}

function isZodSchema(value: unknown): value is ZodSchema {
  return (
    typeof value === "object" &&
    value !== null &&
    "_def" in value &&
    "parse" in value
  );
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
export function tool<TSchema extends ZodSchema | ToolJsonSchema>(config: {
  name: string;
  description?: string;
  inputSchema: TSchema;
  varHints?: { name: string; required?: boolean; description?: string }[];
  /** Intrinsic tags for this tool. Merged with tags provided to `addTool()`. */
  tags?: string[];
  execute: (
    input: TSchema extends ZodSchema<infer T> ? T : unknown,
    ctx: ToolContext
  ) => Promise<ToolResult>;
}): Tool<TSchema extends ZodSchema<infer T> ? T : unknown> {
  let jsonSchema: ToolJsonSchema;
  if (isZodSchema(config.inputSchema)) {
    // Zod 4 emits JSON Schema itself; inline reused schemas and never throw
    // on a shape JSON Schema cannot express (it becomes `{}`), so a tool's
    // parameters are always a plain OpenAPI-style object schema.
    jsonSchema = z.toJSONSchema(config.inputSchema as z.ZodType, {
      target: "openapi-3.0",
      reused: "inline",
      unrepresentable: "any"
    }) as ToolJsonSchema;
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

export function isTool(obj: unknown): obj is Tool {
  return (
    typeof obj === "object" &&
    obj !== null &&
    "meta" in obj &&
    "execute" in obj &&
    typeof (obj as Tool).execute === "function"
  );
}

export { z } from "zod";
