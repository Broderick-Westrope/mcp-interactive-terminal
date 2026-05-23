import { describe, it, expect, vi } from "vitest";
import { handleResizeSession } from "../src/tools/resize-session.js";
import type { SessionManager } from "../src/session-manager.js";
import type { Session, TerminalWrapper } from "../src/types.js";

function makeMockTerminal(mode: "pty" | "pipe", isAlive: boolean): TerminalWrapper {
  return {
    process: { pid: 1234, kill: vi.fn() },
    pid: 1234,
    isAlive,
    promptPattern: null,
    mode,
    write: vi.fn(),
    readScreen: vi.fn().mockReturnValue(""),
    waitForOutput: vi.fn().mockResolvedValue({ output: "", isComplete: true }),
    resize: vi.fn(),
    kill: vi.fn(),
    dispose: vi.fn(),
  };
}

function makeMockSession(mode: "pty" | "pipe", isAlive: boolean): Session {
  const terminal = makeMockTerminal(mode, isAlive);
  return {
    id: "test-session",
    name: "test",
    command: "/bin/bash",
    args: [],
    pid: 1234,
    createdAt: new Date(),
    lastActivity: new Date(),
    isAlive,
    terminal,
    pendingDangerousCommands: new Set(),
  };
}

function makeMockSessionManager(session: Session): SessionManager {
  return {
    getSession: vi.fn().mockReturnValue(session),
  } as unknown as SessionManager;
}

describe("handleResizeSession", () => {
  it("resizes a PTY session successfully without warning", async () => {
    const session = makeMockSession("pty", true);
    const sessionManager = makeMockSessionManager(session);

    const result = await handleResizeSession(
      { session_id: "test-session", cols: 120, rows: 40 },
      sessionManager,
    );

    expect(result.success).toBe(true);
    expect(result.mode).toBe("pty");
    expect(result.warning).toBeUndefined();
    expect(session.terminal.resize).toHaveBeenCalledWith(120, 40);
  });

  it("resizes a pipe session with success:true and a warning", async () => {
    const session = makeMockSession("pipe", true);
    const sessionManager = makeMockSessionManager(session);

    const result = await handleResizeSession(
      { session_id: "test-session", cols: 100, rows: 30 },
      sessionManager,
    );

    expect(result.success).toBe(true);
    expect(result.mode).toBe("pipe");
    expect(result.warning).toBeTruthy();
    expect(typeof result.warning).toBe("string");
  });

  it("throws an error when resizing a dead session", async () => {
    const session = makeMockSession("pty", false);
    const sessionManager = makeMockSessionManager(session);

    await expect(
      handleResizeSession(
        { session_id: "test-session", cols: 80, rows: 24 },
        sessionManager,
      ),
    ).rejects.toThrow(/not alive/);
  });
});
