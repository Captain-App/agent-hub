import { Plugin } from 'vite';

/**
 * Cloudflare wrangler config subset that users can customize.
 * The plugin will merge this with required defaults for agents-hub.
 */
interface CloudflareConfig {
    name?: string;
    compatibility_date?: string;
    routes?: Array<{
        pattern: string;
        zone_name?: string;
        custom_domain?: boolean;
    }>;
    /** Additional durable_objects bindings (HubAgent/Agency are added automatically) */
    durable_objects?: {
        bindings?: Array<{
            class_name: string;
            name: string;
        }>;
    };
    /** Additional migrations (HubAgent/Agency migration is added automatically) */
    migrations?: Array<{
        new_sqlite_classes?: string[];
        tag: string;
    }>;
    /** Additional containers config */
    containers?: Array<{
        class_name: string;
        image: string;
        instance_type?: string;
        max_instances?: number;
    }>;
    /** Analytics Engine datasets for metrics */
    analytics_engine_datasets?: Array<{
        binding: string;
        dataset: string;
    }>;
    /** Any other wrangler config options */
    [key: string]: unknown;
}
/**
 * Configuration options for the agents-hub Vite plugin.
 *
 * @example
 * ```ts
 * hub({
 *   srcDir: "./hub",
 *   outFile: "./_generated.ts",
 *   defaultModel: "gpt-4o",
 *   sandbox: true,
 *   cloudflare: { name: "my-hub" },
 * })
 * ```
 */
interface AgentsPluginOptions {
    /**
     * Directory containing agents, tools, and plugins subdirectories.
     * The plugin scans `srcDir/agents`, `srcDir/tools`, and `srcDir/plugins`.
     * @default "./hub"
     */
    srcDir?: string;
    /**
     * Output path for the generated entrypoint file.
     * This file exports `HubAgent`, `Agency`, and the request handler.
     * @default "./_generated.ts"
     */
    outFile?: string;
    /**
     * Default LLM model for agents that don't specify one.
     * Can be overridden per-blueprint or per-agency via vars.
     * @default "gpt-4o"
     */
    defaultModel?: string;
    /**
     * Enable sandbox (container) support for isolated code execution.
     * When true, adds Sandbox Durable Object binding and container config.
     * Requires Cloudflare Containers feature.
     * @default false
     */
    sandbox?: boolean;
    /**
     * Cloudflare plugin configuration.
     * - `undefined`: Uses default Cloudflare config (recommended)
     * - `null`: Disables Cloudflare plugin entirely (codegen only mode)
     * - `object`: Merges with required defaults (DO bindings, R2, migrations)
     *
     * @example
     * ```ts
     * // Custom domain and name
     * cloudflare: {
     *   name: "my-agent-hub",
     *   routes: [{ pattern: "agents.example.com/*", zone_name: "example.com" }],
     * }
     *
     * // Codegen only (no Cloudflare plugin)
     * cloudflare: null
     * ```
     */
    cloudflare?: CloudflareConfig | null;
    /**
     * R2 bucket name for agent filesystem storage.
     * @default "agents-hub-fs"
     */
    bucket?: string;
    /**
     * Enable Analytics Engine metrics collection.
     * When true or a string, adds METRICS binding to the Analytics Engine dataset.
     * - `true`: Uses default dataset name "agent_metrics"
     * - `string`: Uses the provided dataset name
     * @default false
     */
    metrics?: boolean | string;
}
/**
 * Creates the agents-hub Vite plugin with integrated Cloudflare support.
 *
 * @example
 * ```ts
 * import { defineConfig } from "vite";
 * import react from "@vitejs/plugin-react";
 * import hub from "agents-hub/vite";
 *
 * export default defineConfig({
 *   plugins: [
 *     react(),
 *     hub({
 *       srcDir: "./hub",
 *       defaultModel: "gpt-4o",
 *       sandbox: true,
 *       cloudflare: {
 *         name: "my-hub",
 *         routes: [{ pattern: "hub.example.com", ... }],
 *       },
 *     }),
 *   ]
 * });
 * ```
 */
declare function agentsPlugin(options?: AgentsPluginOptions): Plugin | Plugin[];

export { type AgentsPluginOptions, type CloudflareConfig, agentsPlugin as default };
