# valet-devin

inference@1 agent provider devin-cli over devin acp.

A [valet](https://github.com/valethq/valet-core) plugin. Imports `@valethq/sdk` only.

## Tool gating

Devin asks permission over ACP for some tool calls. Each permission request first goes through valet's `tool.call` gate, and a denial rejects it. Valet's own MCP tools skip the gate, since `ToolSurface.call` already gates them. Devin's built-in shell does not send permission requests in the modes we've tested, so it is not gated.
