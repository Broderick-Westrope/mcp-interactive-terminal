# mcp-interactive-terminal

MCP server that gives agents interactive terminal sessions for REPLs, shells, and terminal apps.
Think of it as a terminal equivalent to Vercel's [agent-browser](https://github.com/vercel-labs/agent-browser).

## Install

Requires **Node.js >=18.14.1** and npm. Sessions run with your user's permissions and are **not sandboxed by default**.

Add this to your MCP client's configuration (adapt the outer structure if your client requires it):

```json
{
  "mcpServers": {
    "terminal": {
      "command": "npx",
      "args": ["-y", "@thefush/mcp-interactive-terminal"]
    }
  }
}
```

The server uses [MCP](https://modelcontextprotocol.io/) over stdio.
Clients that accept a command can use `npx -y @thefush/mcp-interactive-terminal`.

## How I use it

I primarily use this to let agents test my terminal tools, including my harness [Anvil](https://github.com/Broderick-Westrope/anvil).
An agent running in Anvil can use the terminal MCP to interact with the app and find bugs.

Example prompts:

- "Use terminal MCP to validate your changes to Anvil. Exercise the affected UI and report any bugs."
- "Open a Python REPL and test this function with empty input and duplicate values."
- "Run the local CLI setup wizard and check that its prompts and defaults work."

## Tools

| Tool                        | Purpose                                                |
| --------------------------- | ------------------------------------------------------ |
| `create_session`            | Start a process and return its session ID.             |
| `send_command`              | Send input and wait for output, or return immediately. |
| `read_output`               | Read output without sending input (read-only).         |
| `list_sessions`             | List sessions and their status (read-only).            |
| `close_session`             | Kill and remove a session.                             |
| `send_control`              | Send keys such as Ctrl+C, Ctrl+D, arrows, and Tab.     |
| `resize_session`            | Resize a PTY; no effect in pipe mode.                  |
| `confirm_dangerous_command` | Execute flagged input with a justification.            |

## Terminal behavior

- **PTY mode:** tried first, using `node-pty` and `@xterm/headless`. Renders terminal screens and supports TUI apps, cursor movement, and resizing.
- **Pipe fallback:** used if PTY initialization fails. Supports basic interactive input and strips ANSI codes, but has no terminal emulation or resizing. Full-screen apps, arrows, and completion may not work as expected.
- **Completion is a heuristic:** prompts or settled output can mark a command complete before its work is finished. A timeout returns without killing the process; use `read_output` to check again.

## Safety

Dangerous-command detection checks input patterns sent through `send_command`; confirmation is **not a sandbox**.
Configure your client to auto-approve only `read_output` and `list_sessions`, keeping other tools subject to human approval.

- Command allow/block lists check the executable basename at session creation, not commands entered inside a shell.
- Allowed paths check the starting directory and some path references in `send_command`. They do not confine filesystem access, and confirmation does not repeat those path checks.
- Optional sandboxing currently wraps **pipe-mode processes only**, not PTYs. Initialization or wrapping failures fall back to unsandboxed execution. Check stderr; do not rely on this setting alone for isolation.
- Output redaction is opt-in and pattern-based. Audit logs include raw input even when input logging is off, so avoid sending secrets and protect your logs.

Use a separate container or other external isolation when running untrusted code.

## Configuration

Add an `env` object alongside `command` and `args` in the MCP config, for example:

```json
{
  "MCP_TERMINAL_REDACT_SECRETS": "true",
  "MCP_TERMINAL_IDLE_TIMEOUT": "300000"
}
```

Lists are comma-separated. Use the literal strings `true` and `false` for booleans.
All times below are in milliseconds.

| Variable                             | Default   | Effect                                                                                    |
| ------------------------------------ | --------- | ----------------------------------------------------------------------------------------- |
| `MCP_TERMINAL_MAX_SESSIONS`          | `10`      | Maximum stored sessions; close finished sessions to free slots.                           |
| `MCP_TERMINAL_MAX_OUTPUT`            | `20000`   | Output character limit, overridable per `send_command` call.                              |
| `MCP_TERMINAL_DEFAULT_TIMEOUT`       | `5000`    | Confirmation waits twice this value; `send_command` independently defaults to 5000.       |
| `MCP_TERMINAL_SETTLE_MS`             | `300`     | Output settling interval for startup and completion detection.                            |
| `MCP_TERMINAL_BLOCKED_COMMANDS`      | Unset     | Executable basenames blocked at session creation.                                         |
| `MCP_TERMINAL_ALLOWED_COMMANDS`      | Unset     | If set, only these executable basenames can start sessions. Blocklist still applies.      |
| `MCP_TERMINAL_ALLOWED_PATHS`         | Unset     | Allowed starting directories and checked input paths; not filesystem isolation.           |
| `MCP_TERMINAL_REDACT_SECRETS`        | `false`   | Redact recognized secrets in returned output, not logs.                                   |
| `MCP_TERMINAL_LOG_INPUTS`            | `false`   | Additional input logging to stderr; audit logging is independent.                         |
| `MCP_TERMINAL_IDLE_TIMEOUT`          | `1800000` | Close sessions after inactivity (30 minutes); `0` disables. Output reads do not reset it. |
| `MCP_TERMINAL_DANGER_DETECTION`      | `true`    | Require confirmation for recognized dangerous input patterns.                             |
| `MCP_TERMINAL_AUDIT_LOG`             | Unset     | Append JSON Lines audit records to this file, in addition to stderr.                      |
| `MCP_TERMINAL_SANDBOX`               | `false`   | Attempt sandbox initialization; pipe-mode only, with unsandboxed fallback.                |
| `MCP_TERMINAL_SANDBOX_ALLOW_WRITE`   | `/tmp`    | Writable paths when sandboxing is active; reads are unrestricted.                         |
| `MCP_TERMINAL_SANDBOX_ALLOW_NETWORK` | `*`       | Allowed network domains when sandboxing is active; `*` allows all.                        |

## Troubleshooting

- **Server missing or failing to start:** run `npx -y @thefush/mcp-interactive-terminal` and inspect stderr. It waits for MCP input after startup.
- **Wrong Node version:** check `node --version` in the client's environment. Use the absolute `npx` path from `command -v npx` if the client cannot find your version manager's installation.
- **Garbled TUI output:** look for `falling back to pipe mode` in stderr. Fix the reported `node-pty` error; native builds may need your platform's compiler toolchain and Python.
- **Process fails to start:** pass the executable as `command` and arguments separately as `args`. For shell syntax, create a shell session first and send the command there.
- **Slow command:** set `send_command.timeout_ms` up to `60000`, or use `fire_and_forget` and poll with `read_output`. The global timeout setting does not change `send_command`'s default.

## Development

From a checkout of this repository:

```bash
npm install
npm run build
npm test
```

Use `npm run dev` to watch TypeScript changes, `npm start` to run the built server,
and `npm run inspect` to launch MCP Inspector after building.

## License

[MIT](LICENSE)
