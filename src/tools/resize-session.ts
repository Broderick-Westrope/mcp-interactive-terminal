import { z } from "zod";
import type { SessionManager } from "../session-manager.js";
import type { ResizeSessionOutput } from "../types.js";
import { audit } from "../utils/audit-logger.js";

export const resizeSessionSchema = z.object({
  session_id: z.string().describe("The session ID"),
  cols: z.number().min(40).max(300).describe("New terminal width"),
  rows: z.number().min(10).max(100).describe("New terminal height"),
});

export type ResizeSessionArgs = z.infer<typeof resizeSessionSchema>;

export async function handleResizeSession(
  args: ResizeSessionArgs,
  sessionManager: SessionManager,
): Promise<ResizeSessionOutput> {
  const session = sessionManager.getSession(args.session_id);
  if (!session.isAlive) {
    throw new Error(`Session "${args.session_id}" is not alive`);
  }
  audit("resize", args.session_id, { cols: args.cols, rows: args.rows });
  session.terminal.resize(args.cols, args.rows);
  const result: ResizeSessionOutput = { success: true, mode: session.terminal.mode };
  if (session.terminal.mode === "pipe") {
    result.warning = "Resize has no effect in pipe mode (no PTY).";
  }
  return result;
}
