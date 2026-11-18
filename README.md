# valet-devin

`inference@1` agent provider `devin-cli`, built on Devin CLI's ACP (`devin acp`, JSON-RPC over stdio).

A [valet](https://github.com/valethq/valet-core) plugin. Imports `@valethq/sdk` only. It authenticates as whoever is logged in to `devin` on the host, so there is no API key in valet.

## How it works

- One long-lived `devin acp` child multiplexes every session. `open()` creates or loads an ACP session (`session/new` / `session/load`); the remote id is stored as `resumeId`. A load that fails reseeds with a fresh session so the caller sends the preamble.
- Effort and fast mode arrive as model options (`open({ effort, fast })`, `setModel(model, { effort, fast })`): the model, thought level and speed go through ACP `session/set_config_option`. `listModels` collapses `devin models` so each family is listed once with its `efforts` and `fast`.
- Abort calls `session/cancel`; the child stays up for the next turn.

## Tool gating

Devin asks permission over ACP for some tool calls. Each permission request first goes through valet's `tool.call` gate, and a denial rejects it. Valet's own MCP tools skip the gate, since `ToolSurface.call` already gates them. Devin's built-in shell does not send permission requests in the modes we've tested, so it is not gated.

## Config

Settings are this plugin's config (valet-core 12.1): the UI edits them through core, and every value applies at the next session open (spawn settings need a valet restart).
(`plugins.valet-devin.config`)

| Key               | Meaning                                                                                                         |
| ----------------- | --------------------------------------------------------------------------------------------------------------- |
| `permissionMode`  | `normal` / `accept-edits` (default) / `smart` / `plan` / `bypass`. Sent as `modeId` on open.                    |
| `utilityModel`    | Default `claude-haiku-5-5`. A trailing `-<effort>` still works for the utility path. Empty turns side jobs off. |
| `hideFusion`      | Default `true`. Hides `fusion-*` variants from the model list.                                                  |
| `hideAdaptive`    | Default `true`. Hides the `adaptive` model.                                                                     |
| `denyKinds`       | ACP tool kinds refused when Devin asks permission, e.g. `["execute"]`. Needs a restart.                         |
| `command`         | ACP child command. Default `["devin", "acp"]`. Needs a restart.                                                 |
| `refusalFallback` | Models passed as `--refusal-fallback`. Needs a restart.                                                         |
| `models`          | Replaces `devin models`: `{ id, name?, contextWindow?, maxOutputTokens?, efforts?, defaultEffort?, fast? }`.    |

Permission mode and hide flags are read when a session opens or the model list is served, so config changes apply then. `command`, `refusalFallback` and `denyKinds` apply when the ACP child next starts.

## Tests

`bun test` runs against a fake ACP child (`test/fixtures/fake-acp.ts`). A live test against real `devin acp` is skipped unless `VALET_LIVE_DEVIN=1`.
