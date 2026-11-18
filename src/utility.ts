import { tmpdir } from "node:os";
import type { PluginContext, UtilityModel } from "@valethq/sdk";
import type { AcpClient } from "./acp";
import type { DevinConfig } from "./config";
import { resolveModel } from "./models";
import { DevinSession } from "./session";
import { utilityModel } from "./settings";

const RULES = "Reply with the answer only. Do not use tools.";

/** Side jobs run in a throwaway ACP session in the temp dir, in plan mode so nothing can be edited. */
export function createUtility(ctx: PluginContext<DevinConfig>, client: AcpClient): UtilityModel {
  return {
    model: () => utilityModel(ctx),
    async complete(req, signal) {
      const picked = utilityModel(ctx);
      if (!picked) throw new Error("no utility model is configured");
      const { model, effort } = resolveModel(picked);
      const cwd = tmpdir();
      await client.ensure();
      const created = await client.request("session/new", { cwd, mcpServers: [] });
      const session = new DevinSession({
        client,
        id: String(created.sessionId),
        cwd,
        model,
        ...(effort === undefined ? {} : { effort }),
        mode: "plan",
        configOptions: created.configOptions,
        mcpServers: [],
        reseeded: false,
        log: ctx.log,
        blobPath: (id) => ctx.store.blobs.path(id),
        onClose: () => {},
      });
      try {
        await session.configure();
        let text = "";
        const content = [{ type: "text" as const, text: `${req.system}\n${RULES}\n\n${req.prompt}` }];
        for await (const ev of session.prompt({ content }, signal)) {
          if (ev.type === "text-delta") text += ev.text;
          if (ev.type === "finish" && ev.reason !== "stop")
            throw new Error(ev.error ?? `utility call ended: ${ev.reason}`);
        }
        return text.trim();
      } finally {
        await session.close();
      }
    },
  };
}
