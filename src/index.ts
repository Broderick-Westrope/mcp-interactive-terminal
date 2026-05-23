/**
 * MCP Interactive Terminal Server
 *
 * Provides AI agents with interactive terminal sessions via the
 * Model Context Protocol. Supports REPLs, SSH, databases, and
 * any interactive CLI.
 *
 * NOTE: The CLI entry point is bin.ts (dist/bin.js), which performs
 * a Node version check before importing this module. If you import
 * this module directly, you are responsible for ensuring Node >= 18.14.1.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig, type ServerConfig } from "./types.js";
import { SessionManager } from "./session-manager.js";
import { VERSION } from "./version.js";

import { createSessionSchema, handleCreateSession } from "./tools/create-session.js";
import { sendCommandSchema, handleSendCommand } from "./tools/send-command.js";
import { readOutputSchema, handleReadOutput } from "./tools/read-output.js";
import { handleListSessions } from "./tools/list-sessions.js";
import { closeSessionSchema, handleCloseSession } from "./tools/close-session.js";
import { sendControlSchema, handleSendControl } from "./tools/send-control.js";
import {
  confirmDangerousCommandSchema,
  handleConfirmDangerousCommand,
} from "./tools/confirm-dangerous-command.js";
import { resizeSessionSchema, handleResizeSession } from "./tools/resize-session.js";
import { initSandbox, resetSandbox } from "./sandbox.js";
import { configureAudit, audit } from "./utils/audit-logger.js";

// --- Tool Registration ---

interface ToolDef {
  name: string;
  description: string;
  schema: any;
  annotations: Record<string, unknown>;
  handler: (args: any, sm: SessionManager, cfg: ServerConfig) => Promise<unknown>;
}

const tools: ToolDef[] = [
  { name: "create_session",
    description: "Spawn an interactive terminal session (REPL, shell, database client, SSH, etc.). Returns a session_id for subsequent commands.",
    schema: createSessionSchema.shape,
    annotations: { title: "Create Session", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    handler: (args, sm, cfg) => handleCreateSession(args, sm, cfg) },
  { name: "send_command",
    description: "Send a command/input to an interactive session and wait for output. Returns clean text output (no ANSI codes). Supports append_newline (default true) and fire_and_forget (default false) to return immediately. If a dangerous command is detected, use confirm_dangerous_command first.",
    schema: sendCommandSchema.shape,
    annotations: { title: "Send Command", readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    handler: (args, sm, cfg) => handleSendCommand(args, sm, cfg) },
  { name: "read_output",
    description: "Read the current terminal screen without sending any input. Safe read-only operation.",
    schema: readOutputSchema.shape,
    annotations: { title: "Read Output", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    handler: (args, sm, cfg) => handleReadOutput(args, sm, cfg) },
  { name: "list_sessions",
    description: "List all active interactive terminal sessions. Safe read-only operation.",
    schema: {},
    annotations: { title: "List Sessions", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    handler: (_args, sm, _cfg) => handleListSessions(sm) },
  { name: "close_session",
    description: "Close/kill an interactive terminal session.",
    schema: closeSessionSchema.shape,
    annotations: { title: "Close Session", readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    handler: (args, sm, _cfg) => handleCloseSession(args, sm) },
  { name: "send_control",
    description: "Send a control character or special key to a session (e.g., ctrl+c to interrupt, ctrl+d to send EOF, arrow keys, tab for completion).",
    schema: sendControlSchema.shape,
    annotations: { title: "Send Control", readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    handler: (args, sm, cfg) => handleSendControl(args, sm, cfg) },
  { name: "confirm_dangerous_command",
    description: "Execute a command that was flagged as dangerous by send_command. Requires a justification explaining WHY the command is necessary. This is a separate confirmation step for safety.",
    schema: confirmDangerousCommandSchema.shape,
    annotations: { title: "Confirm Dangerous Command", readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    handler: (args, sm, cfg) => handleConfirmDangerousCommand(args, sm, cfg) },
  { name: "resize_session",
    description: "Resize a terminal session's dimensions. Only effective in PTY mode; pipe-mode sessions will acknowledge the request but the resize has no effect.",
    schema: resizeSessionSchema.shape,
    annotations: { title: "Resize Session", readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    handler: (args, sm, _cfg) => handleResizeSession(args, sm) },
];

/**
 * Create a configured McpServer with all tools registered.
 * Does NOT connect to any transport — caller is responsible for that.
 */
function createServer(cfg?: ServerConfig) {
  const config = cfg || loadConfig();
  const sessionManager = new SessionManager(config);

  const server = new McpServer({
    name: "mcp-interactive-terminal",
    version: VERSION,
  });

  for (const t of tools) {
    server.tool(t.name, t.description, t.schema, t.annotations, async (args: any) => {
      try {
        const result = await t.handler(args, sessionManager, config);
        return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return {
          content: [{ type: "text" as const, text: `Error: ${(err as Error).message}` }],
          isError: true,
        };
      }
    });
  }

  return { server, config, sessionManager };
}

// --- Lifecycle ---

async function main() {
  const { server, config, sessionManager } = createServer();
  const transport = new StdioServerTransport();

  // Initialize audit logger
  if (config.auditLog) {
    configureAudit(config.auditLog);
  }

  // Initialize sandbox if enabled
  if (config.sandbox) {
    await initSandbox(config);
  }

  // Cleanup on shutdown
  process.on("SIGINT", async () => {
    audit("server_stop");
    sessionManager.closeAll();
    await resetSandbox();
    process.exit(0);
  });
  process.on("SIGTERM", async () => {
    audit("server_stop");
    sessionManager.closeAll();
    await resetSandbox();
    process.exit(0);
  });

  console.error(`[mcp-terminal] Starting MCP Interactive Terminal Server`);
  console.error(`[mcp-terminal] Node ${process.versions.node} | ${process.platform} ${process.arch}`);
  console.error(`[mcp-terminal] Config: maxSessions=${config.maxSessions}, maxOutput=${config.maxOutput}, defaultTimeout=${config.defaultTimeout}ms`);

  if (config.dangerDetection) {
    console.error("[mcp-terminal] Dangerous command detection: ENABLED");
  }
  if (config.redactSecrets) {
    console.error("[mcp-terminal] Secret redaction: ENABLED");
  }
  if (config.blockedCommands.length > 0) {
    console.error(`[mcp-terminal] Blocked commands: ${config.blockedCommands.join(", ")}`);
  }
  if (config.allowedCommands.length > 0) {
    console.error(`[mcp-terminal] Allowed commands: ${config.allowedCommands.join(", ")}`);
  }
  if (config.allowedPaths.length > 0) {
    console.error(`[mcp-terminal] Allowed paths: ${config.allowedPaths.join(", ")}`);
  }
  if (config.auditLog) {
    console.error(`[mcp-terminal] Audit log: ${config.auditLog}`);
  }

  audit("server_start", undefined, {
    maxSessions: config.maxSessions,
    dangerDetection: config.dangerDetection,
    sandbox: config.sandbox,
    redactSecrets: config.redactSecrets,
    allowedCommands: config.allowedCommands,
    blockedCommands: config.blockedCommands,
    allowedPaths: config.allowedPaths,
  });

  await server.connect(transport);
}

// Only start the server when run directly (not when imported for scanning by Smithery etc.)
const isDirectRun = process.argv[1] &&
  (process.argv[1].endsWith("/bin.js") ||
   process.argv[1].endsWith("/index.js") ||
   process.argv[1].endsWith("mcp-interactive-terminal"));

if (isDirectRun) {
  main().catch((err) => {
    console.error("[mcp-terminal] Fatal error:", err);
    process.exit(1);
  });
}

// Export for Smithery scanning — returns a fresh, unconnected server
export default createServer;
export function createSandboxServer() {
  const { server } = createServer();
  return server;
}
