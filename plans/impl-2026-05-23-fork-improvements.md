# MCP Interactive Terminal Fork Improvements

> **Status:** DRAFT

## Specification

**Problem:** The upstream `mcp-interactive-terminal` has several issues that
degrade the experience when used as an AI agent's terminal backend:

1. Every `create_session` burns a hardcoded 1-second delay for prompt
   detection, making session creation feel sluggish.
2. `send_command` always appends `\n` — there's no way to send raw input
   for tab completion, single-character prompts (y/n), or partial input.
3. The `isAlive` polling interval leaks (never cleared on session close) and
   can report stale state within its 1-second window.
4. The secret redactor's `POSSIBLE_AWS_SECRET` pattern matches any
   40-character base64-ish string, false-positiving on git SHAs, file hashes,
   and base64 output.
5. Tool registration in `index.ts` is ~180 lines of repetitive boilerplate.
6. There is no `resize_session` tool despite the terminal wrapper supporting
   `resize()`.
7. `send_command` has no fire-and-forget mode — it always blocks waiting for
   output even when the caller doesn't need it.
8. Pipe-mode ctrl+c doesn't clear the output buffer, causing stale output to
   bleed into subsequent reads.
9. The `findDisallowedPath` regex is trivially bypassed with relative paths,
   tilde expansion, or variable expansion.
10. The server version is hardcoded to `"1.0.0"` while `package.json` says
    `1.0.9`.

**Goal:** A cleaner, faster, more correct fork that:
- Creates sessions in ~400ms instead of 1000ms.
- Supports raw input without forced newlines.
- Has no resource leaks or stale state.
- Doesn't false-positive on common output patterns.
- Has clean, DRY tool registration.
- Exposes terminal resize via MCP.

**Scope:**

- In: All 10 items above, plus the `OUTPUT_SETTLE_MS` configurability and
  additional `pipeInteractiveArgs` entries.
- Out: The Anthropic sandbox integration (`sandbox.ts`) — we won't modify
  it. The existing test suite — we'll add tests for new behavior but won't
  refactor existing tests.

**Success Criteria:**

- [ ] `create_session` completes in <500ms for a standard bash shell.
- [ ] `send_command` with `append_newline: false` sends raw input without `\n`.
- [ ] No `setInterval` leak after `closeSession`.
- [ ] `redactSecrets` does not redact 40-char hex strings (git SHAs).
- [ ] Tool registration in `index.ts` is under 60 lines.
- [ ] `resize_session` tool works in PTY mode and no-ops in pipe mode.
- [ ] `send_command` with `fire_and_forget: true` returns immediately.
- [ ] Pipe-mode ctrl+c clears the output buffer.
- [ ] `findDisallowedPath` handles `..` traversal and `~` expansion.
- [ ] Server version matches `package.json`.
- [ ] All existing tests pass; new tests cover new behavior.

## Context Loading

```bash
read src/index.ts
read src/terminal.ts
read src/session-manager.ts
read src/types.ts
read src/tools/send-command.ts
read src/tools/send-control.ts
read src/utils/secret-redactor.ts
read src/utils/danger-detector.ts
read src/utils/output-detector.ts
read src/utils/sanitizer.ts
read package.json
```

## Terminal & Session Tasks

### Task 1: Replace 1-second startup delay with settled-output polling

**Context:** `src/terminal.ts` — both `createPtyTerminal` (~line 126) and
`createPipeTerminal` (~line 242)

**Files:**
- Modify: `src/terminal.ts`
- Test: `tests/terminal.test.ts` (add timing assertion)

**Steps:**

1. [ ] In `createPtyTerminal`, replace the hardcoded
   `await new Promise((r) => setTimeout(r, 1000))` (line 126) with a
   polling loop that resolves once output has settled. Use the same
   `OUTPUT_SETTLE_MS` constant (300ms) and a 50ms poll interval:
   ```typescript
   // Wait for startup output to settle before detecting prompt.
   const startupStart = Date.now();
   const STARTUP_TIMEOUT = 3000; // max wait
   let lastLen = 0;
   await new Promise<void>((resolve) => {
     const poll = () => {
       const currentLen = outputBuffer.length;
       const elapsed = Date.now() - startupStart;
       if (elapsed >= STARTUP_TIMEOUT) { resolve(); return; }
       if (currentLen > 0 && currentLen === lastLen) {
         // Output settled — wait one more settle period to be sure
         setTimeout(() => {
           if (outputBuffer.length === currentLen) resolve();
           else { lastLen = outputBuffer.length; setTimeout(poll, 50); }
         }, OUTPUT_SETTLE_MS);
         return;
       }
       lastLen = currentLen;
       setTimeout(poll, 50);
     };
     setTimeout(poll, 50);
   });
   ```
2. [ ] Extract the polling logic into a shared `waitForStartup` helper
   that works for both PTY and pipe modes. It takes a getter function
   (not the buffer directly) so it can re-read the length on each tick:
   ```typescript
   async function waitForStartup(
     getBufferLen: () => number,
     settleMs: number,
     timeoutMs: number = 3000,
   ): Promise<void> {
     const start = Date.now();
     let lastLen = 0;
     return new Promise<void>((resolve) => {
       const poll = () => {
         const currentLen = getBufferLen();
         if (Date.now() - start >= timeoutMs) { resolve(); return; }
         if (currentLen > 0 && currentLen === lastLen) {
           setTimeout(() => {
             if (getBufferLen() === currentLen) resolve();
             else { lastLen = getBufferLen(); setTimeout(poll, 50); }
           }, settleMs);
           return;
         }
         lastLen = currentLen;
         setTimeout(poll, 50);
       };
       setTimeout(poll, 50);
     });
   }
   ```
3. [ ] In `createPipeTerminal`, replace the `setTimeout(() => { ...
   resolve(wrapper); }, 1000)` block. The pipe mode constructs `wrapper`
   and `newOutputBuffer` inside a Promise callback, so call
   `waitForStartup` inside that same closure, passing
   `() => newOutputBuffer.length` as the getter:
   ```typescript
   // Replace the setTimeout(resolve, 1000) with:
   await waitForStartup(() => newOutputBuffer.length, OUTPUT_SETTLE_MS);
   const startupScreen = wrapper.readScreen();
   promptPattern = detectPromptPattern(startupScreen);
   wrapper.promptPattern = promptPattern;
   resolve(wrapper);
   ```
   Note: this requires making the promise executor `async` or chaining
   the `waitForStartup` call with `.then()`.
4. [ ] Make `OUTPUT_SETTLE_MS` configurable via a new
   `MCP_TERMINAL_SETTLE_MS` env var in `loadConfig()` in `src/types.ts`.
   Add `settleMs: number` to `ServerConfig`. Default: 300.
5. [ ] Add a test in `tests/terminal.test.ts` that verifies the startup
   mechanism. Rather than a flaky timing assertion, verify the *mechanism*:
   mock `setTimeout` via `vi.useFakeTimers()` and assert that the
   `waitForStartup` helper resolves once the buffer stops growing, and
   that no 1000ms `setTimeout` is called. Additionally add a pragmatic
   timing test with a generous 3000ms bound (still 3x faster than the
   old 1s + overhead) and skip it in CI via
   `describe.skipIf(process.env.CI)`.

**Verify:**
```bash
npm test -- tests/terminal.test.ts
# Expected: all tests pass, including new timing test
```

### Task 2: Fix `isAlive` interval leak and stale state

**Context:** `src/session-manager.ts` — `createSession` (line 58-64) and
`closeSession`

**Files:**
- Modify: `src/session-manager.ts`
- Modify: `src/types.ts` (add field to `Session` interface)
- Test: `tests/session-manager.test.ts` (add leak test)

**Steps:**

1. [ ] Add an `aliveCheckInterval` field to the `Session` interface in
   `src/types.ts`:
   ```typescript
   aliveCheckInterval?: ReturnType<typeof setInterval>;
   ```
2. [ ] In `createSession`, store the interval handle on the session:
   ```typescript
   session.aliveCheckInterval = setInterval(() => {
     if (!terminal.isAlive) {
       session.isAlive = false;
       clearInterval(session.aliveCheckInterval!);
     }
   }, 1000);
   ```
3. [ ] In `closeSession`, clear the interval before disposing:
   ```typescript
   if (session.aliveCheckInterval) {
     clearInterval(session.aliveCheckInterval);
   }
   ```
4. [ ] In `closeAll`, ensure intervals are cleared even if `closeSession`
   throws. Add a `finally` block or iterate sessions to clear intervals
   before calling `closeSession`:
   ```typescript
   closeAll(): void {
     for (const [id, session] of this.sessions) {
       if (session.aliveCheckInterval) clearInterval(session.aliveCheckInterval);
       try { this.closeSession(id); } catch { /* ignore */ }
     }
   }
   ```
5. [ ] Add a test that creates a session, closes it, and verifies no
   lingering timers (use `vi.useFakeTimers` and assert no pending timers
   after close).

**Verify:**
```bash
npm test -- tests/session-manager.test.ts
```

### Task 3: Clear pipe-mode output buffer on ctrl+c

**Context:** `src/tools/send-control.ts` (line 65-80), `src/terminal.ts`
pipe-mode wrapper

**Files:**
- Modify: `src/terminal.ts` (add `clearOutputBuffer()` to pipe wrapper)
- Modify: `src/types.ts` (add optional `clearOutputBuffer` to
  `TerminalWrapper`)
- Modify: `src/tools/send-control.ts` (call clear after signal)

**Steps:**

1. [ ] Add `clearOutputBuffer?(): void` to the `TerminalWrapper` interface.
2. [ ] In the pipe-mode wrapper in `terminal.ts`, implement it:
   ```typescript
   clearOutputBuffer() {
     newOutputBuffer = "";
   },
   ```
3. [ ] In PTY mode, don't implement it (xterm handles buffer management).
4. [ ] In `send-control.ts`, after sending SIGINT/SIGQUIT/SIGTSTP in pipe
   mode, call `session.terminal.clearOutputBuffer?.()`.

**Verify:**
```bash
npm test -- tests/pipe-terminal.test.ts
```

## Tool API Tasks

### Task 4: Add `append_newline` and `fire_and_forget` to `send_command`

**Context:** `src/tools/send-command.ts`, `src/types.ts`

**Files:**
- Modify: `src/tools/send-command.ts`
- Modify: `src/types.ts` (`SendCommandInput`, `SendCommandOutput`)
- Test: existing tests should still pass; add new tests

**Steps:**

1. [ ] Add two optional fields to `sendCommandSchema`:
   ```typescript
   append_newline: z.boolean().optional().default(true)
     .describe("Whether to append a newline after the input (default true)"),
   fire_and_forget: z.boolean().optional().default(false)
     .describe("Send input and return immediately without waiting for output"),
   ```
2. [ ] Update `SendCommandInput` in `types.ts` to include both fields.
3. [ ] In `handleSendCommand`, change the write line:
   ```typescript
   const suffix = args.append_newline !== false ? "\n" : "";
   session.terminal.write(args.input + suffix);
   ```
4. [ ] Add fire-and-forget early return **after** the `write()` call
   (i.e., after existing line 98: `session.terminal.write(...)`) and
   **before** the `waitForOutput` call. Danger detection and path
   checking still run — only the output wait is skipped. No sanitization
   or secret redaction is needed since no output is returned:
   ```typescript
   // Insert after session.terminal.write(args.input + suffix):
   if (args.fire_and_forget) {
     return {
       output: "",
       is_complete: false,
       is_alive: session.terminal.isAlive,
       warning: "Input sent (fire-and-forget mode). Use read_output to check results.",
     };
   }
   ```
5. [ ] Update the tool description in `index.ts` registration to mention
   both new options.

**Verify:**
```bash
npm test
```

### Task 5: Add `resize_session` tool

**Context:** `src/index.ts`, `src/tools/`

**Files:**
- Create: `src/tools/resize-session.ts`
- Modify: `src/index.ts` (register new tool)
- Modify: `src/types.ts` (add `ResizeSessionInput/Output`)

**Steps:**

1. [ ] Create `src/tools/resize-session.ts`:
   ```typescript
   import { z } from "zod";
   import type { SessionManager } from "../session-manager.js";
   import { audit } from "../utils/audit-logger.js";

   export const resizeSessionSchema = z.object({
     session_id: z.string().describe("The session ID"),
     cols: z.number().min(40).max(300).describe("New terminal width"),
     rows: z.number().min(10).max(100).describe("New terminal height"),
   });

   export type ResizeSessionArgs = z.infer<typeof resizeSessionSchema>;

   export interface ResizeSessionOutput {
     success: boolean;
     mode: "pty" | "pipe";
     warning?: string;
   }

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
   ```
2. [ ] Register the tool in `index.ts` (this will be simplified in Task 7).
3. [ ] Add tests in `tests/resize-session.test.ts`: PTY resize succeeds
   without warning; pipe-mode resize returns `success: true` with a
   warning string.

**Verify:**
```bash
npm run build && npm test -- tests/resize-session.test.ts
```

## Security & Sanitization Tasks

### Task 6: Fix secret redactor false positives and path bypass

**Context:** `src/utils/secret-redactor.ts`, `src/tools/send-command.ts`

**Files:**
- Modify: `src/utils/secret-redactor.ts`
- Modify: `src/tools/send-command.ts` (`findDisallowedPath`)
- Modify: `tests/secret-redactor.test.ts`

**Steps:**

1. [ ] Remove the `POSSIBLE_AWS_SECRET` pattern entirely from
   `SECRET_PATTERNS` — it's too broad. The `AKIA` prefix pattern already
   catches AWS access keys; the secret key is only meaningful paired with
   one.
2. [ ] The existing `pattern.lastIndex = 0` reset before each call is
   sufficient to prevent shared-state issues. No regex mechanism change
   needed — leave the `g` flag and `lastIndex` reset as-is.
3. [ ] Add test cases to `tests/secret-redactor.test.ts`:
   - A 40-char hex string (git SHA) must NOT be redacted.
   - An `AKIA...` key must still be redacted.
   - A GitHub PAT (`ghp_...`) must still be redacted.
4. [ ] In `findDisallowedPath` in `send-command.ts`, add handling for:
   - Relative path traversal: resolve `..` segments via
     `path.resolve(sessionCwd, candidate)` before checking.
   - Tilde expansion: replace leading `~` with `os.homedir()`.
   ```typescript
   import { homedir } from "node:os";

   function expandPath(p: string, cwd: string): string {
     if (p.startsWith("~")) p = homedir() + p.slice(1);
     return resolvePath(cwd, p);
   }
   ```
5. [ ] Add a prominent comment above `findDisallowedPath`:
   ```typescript
   // Defense-in-depth only. Variable expansion ($HOME, $(cmd)) is NOT
   // handled — that would require shell evaluation which is itself a
   // security risk. Do not rely on this as a security boundary.
   ```

**Verify:**
```bash
npm test -- tests/secret-redactor.test.ts
```

## DX & Cleanup Tasks

### Task 7: DRY up tool registration and sync server version

**Context:** `src/index.ts`, `package.json`

**Files:**
- Modify: `src/index.ts`
- Create: `src/version.ts` (optional, or read from package.json)

**Steps:**

1. [ ] Read the version from `package.json` at startup. Create
   `src/version.ts` using `createRequire` which works correctly whether
   the package is run from source, from `dist/`, or from `node_modules/`:
   ```typescript
   import { createRequire } from "node:module";

   let VERSION = "0.0.0";
   try {
     const require = createRequire(import.meta.url);
     const pkg = require("../package.json");
     VERSION = pkg.version ?? VERSION;
   } catch {
     // Fallback if package.json can't be found (e.g., bundled).
   }
   export { VERSION };
   ```
2. [ ] Use `VERSION` in the `McpServer` constructor instead of `"1.0.0"`.
3. [ ] Refactor tool registration into a data-driven loop. Define a
   `ToolDef` type and an array of tool definitions:
   ```typescript
   interface ToolDef {
     name: string;
     description: string;
     schema: Record<string, unknown>;
     annotations: Record<string, unknown>;
     handler: (args: any, sm: SessionManager, cfg: ServerConfig) => Promise<unknown>;
   }

   const tools: ToolDef[] = [
     {
       name: "create_session",
       description: "Spawn an interactive terminal session...",
       schema: createSessionSchema.shape,
       annotations: { title: "Create Session", readOnlyHint: false, ... },
       handler: (args, sm, cfg) => handleCreateSession(args, sm, cfg),
     },
     // ... one entry per tool
   ];

   for (const t of tools) {
     server.tool(t.name, t.description, t.schema, t.annotations, async (args) => {
       try {
         const result = await t.handler(args, sessionManager, config);
         return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
       } catch (err) {
         return {
           content: [{ type: "text", text: `Error: ${(err as Error).message}` }],
           isError: true,
         };
       }
     });
   }
   ```
4. [ ] Include the new `resize_session` tool from Task 5 in the array.
5. [ ] Verify the total tool registration section is under 60 lines.

**Verify:**
```bash
npm run build && npm test
```

### Task 8: Add missing `pipeInteractiveArgs` entries

**Context:** `src/terminal.ts` — `pipeInteractiveArgs` function (~line 137)

**Files:**
- Modify: `src/terminal.ts`
- Test: `tests/pipe-terminal.test.ts`

**Steps:**

1. [ ] Add entries for commonly used interactive programs:
   ```typescript
   // Ruby IRB: needs --noreadline in pipe mode
   if (base === "irb") {
     if (!args.includes("--noreadline")) return ["--noreadline", ...args];
     return args;
   }

   // Lua: needs -i for interactive mode
   if (base === "lua" || /^lua5\.\d$/.test(base)) {
     if (!args.includes("-i")) return ["-i", ...args];
     return args;
   }

   // SQLite3: needs -interactive in pipe mode
   if (base === "sqlite3") {
     if (!args.includes("-interactive")) return ["-interactive", ...args];
     return args;
   }
   ```
2. [ ] Add tests for each new entry in `tests/pipe-terminal.test.ts`.

**Verify:**
```bash
npm test -- tests/pipe-terminal.test.ts
```

<!--
## Review Notes

Devil's advocate review caught:

**Incorporated (Critical):**
- Task 1 pipe-mode startup polling was under-specified — the getter
  function pattern and promise-executor interaction were unclear. Now
  explicit with `waitForStartup(() => newOutputBuffer.length, ...)`.
- Task 7 `version.ts` using `readFileSync` with `__dirname` would break
  when installed as an npm dependency. Switched to `createRequire` with
  try-catch fallback.

**Incorporated (Important):**
- Task 1 timing test was flaky — replaced with mechanism verification
  via `vi.useFakeTimers` plus optional CI-skippable timing test.
- Task 2 `closeAll` didn't clear intervals if `closeSession` threw.
  Added explicit interval cleanup before the try-catch.
- Task 4 fire-and-forget placement was ambiguous — clarified it goes
  after write() and before waitForOutput().
- Task 5 had no tests and no pipe-mode warning. Added both.
- Task 6 regex `g` flag change was unnecessary — the existing
  `lastIndex = 0` reset is sufficient. Removed the regex refactor.
- Task 6 path bypass handling documented as defense-in-depth only.
- Task 7 `ToolDef` erases type safety via `any` — accepted as a
  tradeoff for DRY (8 tools change rarely), noted in review.

**Acknowledged (not changed):**
- Task 1 startup timeout of 3s is a regression for silent commands
  (e.g., `cat`). The old 1s was also arbitrary; 3s is more generous
  but bounded. Acceptable tradeoff.
- Task 7 tool registration loop loses per-handler type safety. The
  tradeoff (DRY for 8 tools vs. type safety) is acceptable since tool
  schemas are tested via Zod validation at runtime.
-->
