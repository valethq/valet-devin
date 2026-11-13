# Spike: `devin acp` (devin 3000.12.57)

Measured on this host; the results below supersede ARCHITECTURE.md 11.3 where they differ.

- **Resume:** `initialize` advertises `agentCapabilities.loadSession = true`. `session/load { sessionId, cwd, mcpServers }` works, and before it responds the agent replays the whole history as `session/update` notifications. The plugin swallows updates for a session while its load is pending. If load errors, the plugin falls back to `session/new` and marks the session as reseeded (`resumeId` differs from the requested one, plus `reseeded: true`) so the caller sends the preamble.
- **Model switching:** `session/set_model` does not exist (-32601). Use `session/set_config_option { sessionId, configId: "model", value }`.
- **Modes:** `session/set_mode { sessionId, modeId }` with `accept-edits`, `smart`, `ask`, `plan`, `bypass`.
- **Built-in exec and permissions:**
  - In `accept-edits` mode the built-in exec tool runs without sending a permission request.
  - When Devin does ask (`session/request_permission`), the client can refuse that call. The plugin does this per tool `kind` via config `denyKinds` (for example `["execute"]`), selecting the `reject_once` option.
  - In `ask` mode Devin has no shell tool at all.
- **M2 route to valet-exec:** Devin's own config supports per-tool permission rules (`Deny(...)`). Denying the built-in exec there, while offering valet-exec over MCP (`session/new.mcpServers`), steers Devin-backed sessions to jobs that survive restarts. Until then, long jobs run inside Devin's process and die with it.
