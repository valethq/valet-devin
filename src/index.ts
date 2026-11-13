import { definePlugin } from "@valethq/sdk";
import type { DevinConfig } from "./config";
import { createProvider, PROVIDER_KEY } from "./provider";
import { registerSettings } from "./settings";

export default definePlugin<DevinConfig>({
  activate(ctx) {
    const { provider, dispose } = createProvider(ctx);
    ctx.onDispose(dispose);
    ctx.scopes.provide("inference", provider, { key: PROVIDER_KEY });
    registerSettings(ctx);
  },
});
