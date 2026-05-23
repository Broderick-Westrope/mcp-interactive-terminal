import { describe, it, expect, afterEach, vi } from "vitest";
import { createTerminal, waitForStartup } from "../src/terminal.js";
import type { TerminalWrapper } from "../src/types.js";
import { canSpawnPty } from "./can-spawn-pty.js";

const BASH = "/bin/bash";
const ptyAvailable = canSpawnPty(BASH);
const itPty = ptyAvailable ? it : it.skip;

describe("Terminal", () => {
  let terminal: TerminalWrapper | null = null;

  afterEach(() => {
    if (terminal) {
      terminal.dispose();
      terminal = null;
    }
  });

  itPty("spawns a bash session", async () => {
    terminal = await createTerminal({ command: BASH });
    expect(terminal.isAlive).toBe(true);
    expect(terminal.pid).toBeGreaterThan(0);
  }, 10000);

  itPty("sends a command and reads output", async () => {
    terminal = await createTerminal({ command: BASH });

    terminal.write("echo hello_test_123\n");
    const { output } = await terminal.waitForOutput(3000);

    expect(output).toContain("hello_test_123");
  }, 10000);

  itPty("reads the screen", async () => {
    terminal = await createTerminal({ command: BASH });

    terminal.write("echo screen_test\n");
    await new Promise((r) => setTimeout(r, 1000));

    const screen = terminal.readScreen();
    expect(screen).toContain("screen_test");
  }, 10000);

  itPty("detects process exit", async () => {
    terminal = await createTerminal({ command: BASH });

    terminal.write("exit\n");
    await new Promise((r) => setTimeout(r, 1000));

    expect(terminal.isAlive).toBe(false);
  }, 10000);

  itPty("handles resize", async () => {
    terminal = await createTerminal({ command: BASH, cols: 80, rows: 24 });
    terminal.resize(120, 40);
    expect(terminal.isAlive).toBe(true);
  }, 10000);

  itPty("throws when writing to dead session", async () => {
    terminal = await createTerminal({ command: BASH });
    terminal.kill();
    await new Promise((r) => setTimeout(r, 200));

    expect(() => terminal!.write("test\n")).toThrow(/not alive/);
  }, 10000);
});

describe("waitForStartup", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("resolves when buffer stops growing", async () => {
    vi.useFakeTimers();
    let buffer = "";

    const promise = waitForStartup(() => buffer.length, 300, 3000);

    // First poll — buffer is empty, keep polling
    await vi.advanceTimersByTimeAsync(50);

    // Buffer gets some data
    buffer = "startup output";

    // Poll sees data, same length on next poll triggers settle check
    await vi.advanceTimersByTimeAsync(50);
    // Buffer hasn't grown — settle timer fires
    await vi.advanceTimersByTimeAsync(300);
    // Final confirmation check
    await vi.advanceTimersByTimeAsync(50);

    await expect(promise).resolves.toBeUndefined();
  });

  it("resolves on timeout if buffer never settles", async () => {
    vi.useFakeTimers();
    let count = 0;

    // Buffer keeps growing on every check
    const promise = waitForStartup(() => ++count, 300, 500);

    // Advance past the timeout
    await vi.advanceTimersByTimeAsync(501);

    await expect(promise).resolves.toBeUndefined();
  });
});
