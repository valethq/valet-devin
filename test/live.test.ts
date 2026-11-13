import { expect, test } from "bun:test";
import { collect, fakeCtx, input } from "./helpers";

test.skipIf(process.env.VALET_LIVE_DEVIN !== "1")(
  "live devin acp",
  async () => {
    const h = fakeCtx({});
    try {
      const s = await h.provider.open({
        sessionId: "s1",
        cwd: process.cwd(),
        model: "swe-2-high",
        mcpServers: [],
        signal: new AbortController().signal,
      });
      const events = await collect(s.prompt(input("reply with the word pong"), new AbortController().signal));
      const text = events.flatMap((e) => (e.type === "text-delta" ? [e.text] : [])).join("");
      expect(text.toLowerCase()).toContain("pong");
      await s.close();
    } finally {
      await h.dispose();
    }
  },
  120_000,
);
