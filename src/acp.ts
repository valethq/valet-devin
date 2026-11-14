import type { Logger } from "@valethq/sdk";

export type Obj = Record<string, unknown>;
/** Returns a denial reason to refuse a permission request, or undefined to let the normal rules decide. */
export type Guard = (toolCall: Obj) => Promise<string | undefined>;
type Pending = { resolve(v: Obj): void; reject(e: Error): void };
type Proc = Bun.Subprocess<"pipe", "pipe", "ignore">;

export interface AcpOptions {
  command: string[];
  denyKinds: string[];
  log: Logger;
}

const MIN_DELAY = 1000;
const MAX_DELAY = 30_000;

export class AcpClient {
  private proc?: Proc;
  private ready?: Promise<void>;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private listeners = new Map<string, (update: Obj) => void>();
  private guards = new Map<string, Guard>();
  private loading = new Set<string>();
  private delay = MIN_DELAY;
  private retryAt = 0;
  private startedAt = 0;
  private disposed = false;
  generation = 0;
  loadSupported = false;
  imageSupported = false;

  constructor(private opts: AcpOptions) {}

  listen(sessionId: string, fn: (update: Obj) => void): void {
    this.listeners.set(sessionId, fn);
  }

  unlisten(sessionId: string): void {
    this.listeners.delete(sessionId);
  }

  /** Asked before each permission request for the session. Resolves to a denial reason, or undefined to allow. */
  guard(sessionId: string, fn: Guard): void {
    this.guards.set(sessionId, fn);
  }

  unguard(sessionId: string): void {
    this.guards.delete(sessionId);
  }

  async request(method: string, params: Obj): Promise<Obj> {
    await this.ensure();
    return this.send(method, params);
  }

  async loadSession(sessionId: string, cwd: string, mcpServers: Obj[]): Promise<Obj> {
    await this.ensure();
    this.loading.add(sessionId);
    try {
      return await this.send("session/load", { sessionId, cwd, mcpServers });
    } finally {
      this.loading.delete(sessionId);
    }
  }

  notify(method: string, params: Obj): void {
    this.write({ jsonrpc: "2.0", method, params });
  }

  dispose(): void {
    this.disposed = true;
    this.proc?.kill();
    this.failAll(new Error("valet-devin disposed"));
  }

  ensure(): Promise<void> {
    if (this.disposed) return Promise.reject(new Error("valet-devin disposed"));
    this.ready ??= this.boot().catch((e) => {
      this.ready = undefined;
      throw e;
    });
    return this.ready;
  }

  private async boot(): Promise<void> {
    const wait = this.retryAt - Date.now();
    if (wait > 0) await Bun.sleep(wait);
    let proc: Proc;
    try {
      proc = Bun.spawn(this.opts.command, { stdin: "pipe", stdout: "pipe", stderr: "ignore" });
    } catch (e) {
      this.backoff(0);
      throw e;
    }
    this.proc = proc;
    this.startedAt = Date.now();
    this.generation++;
    void this.readLoop(proc);
    void proc.exited.then((code) => this.onExit(proc, code));
    const init = await this.send("initialize", {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
    });
    const caps = init.agentCapabilities as Obj | undefined;
    this.loadSupported = caps?.loadSession === true;
    this.imageSupported = (caps?.promptCapabilities as Obj | undefined)?.image === true;
  }

  private backoff(uptime: number): void {
    if (uptime > MAX_DELAY * 2) this.delay = MIN_DELAY;
    this.retryAt = Date.now() + this.delay;
    this.delay = Math.min(this.delay * 2, MAX_DELAY);
  }

  private onExit(proc: Proc, code: number): void {
    if (this.proc !== proc) return;
    this.proc = undefined;
    this.ready = undefined;
    if (this.disposed) return;
    this.opts.log.warn("devin acp exited", { code });
    this.backoff(Date.now() - this.startedAt);
    this.failAll(new Error(`devin acp exited with code ${code}`));
  }

  private failAll(err: Error): void {
    const pending = [...this.pending.values()];
    this.pending.clear();
    for (const p of pending) p.reject(err);
  }

  private send(method: string, params: Obj): Promise<Obj> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try {
        this.write({ jsonrpc: "2.0", id, method, params });
      } catch (e) {
        this.pending.delete(id);
        reject(e as Error);
      }
    });
  }

  private write(msg: Obj): void {
    const stdin = this.proc?.stdin;
    if (!stdin) throw new Error("devin acp is not running");
    stdin.write(`${JSON.stringify(msg)}\n`);
    stdin.flush();
  }

  private async readLoop(proc: Proc): Promise<void> {
    const decoder = new TextDecoder();
    let buf = "";
    try {
      for await (const chunk of proc.stdout) {
        buf += decoder.decode(chunk, { stream: true });
        for (let i = buf.indexOf("\n"); i >= 0; i = buf.indexOf("\n")) {
          const line = buf.slice(0, i).trim();
          buf = buf.slice(i + 1);
          if (line) this.dispatch(line);
        }
      }
    } catch (e) {
      this.opts.log.warn("devin acp read failed", { error: String(e) });
    }
  }

  private dispatch(line: string): void {
    let msg: Obj;
    try {
      msg = JSON.parse(line) as Obj;
    } catch {
      return;
    }
    const { id, method } = msg;
    if (typeof method === "string") {
      const params = (msg.params ?? {}) as Obj;
      if (id === undefined) this.onNotification(method, params);
      else this.onRequest(id as number | string, method, params);
      return;
    }
    const p = this.pending.get(id as number);
    if (!p) return;
    this.pending.delete(id as number);
    const error = msg.error as Obj | undefined;
    if (error) {
      const message = String(error.message ?? "acp error");
      p.reject(new Error(typeof error.data === "string" ? `${message}: ${error.data}` : message));
    } else p.resolve((msg.result ?? {}) as Obj);
  }

  private onNotification(method: string, params: Obj): void {
    if (method !== "session/update") return;
    const sessionId = String(params.sessionId);
    if (this.loading.has(sessionId)) return;
    this.listeners.get(sessionId)?.((params.update ?? {}) as Obj);
  }

  private onRequest(id: number | string, method: string, params: Obj): void {
    const reply = (body: Obj) => this.write({ jsonrpc: "2.0", id, ...body });
    if (method !== "session/request_permission") {
      reply({ error: { code: -32601, message: `method not found: ${method}` } });
    } else {
      this.decide(params).then(
        (outcome) => reply({ result: { outcome } }),
        (error: unknown) => reply({ error: { code: -32603, message: String(error) } }),
      );
    }
  }

  private async decide(params: Obj): Promise<Obj> {
    const toolCall = (params.toolCall ?? {}) as Obj;
    const kind = toolCall.kind;
    this.opts.log.debug("devin permission request", { toolCall });
    const denial = await this.guards.get(String(params.sessionId ?? ""))?.(toolCall);
    if (denial !== undefined) this.opts.log.info("devin tool call denied by policy", { reason: denial });
    const deny = denial !== undefined || (typeof kind === "string" && this.opts.denyKinds.includes(kind));
    const options = (params.options ?? []) as { optionId: string; kind: string }[];
    const wanted = deny ? ["reject_once", "reject_always"] : ["allow_once", "allow_always"];
    for (const k of wanted) {
      const o = options.find((x) => x.kind === k);
      if (o) return { outcome: "selected", optionId: o.optionId };
    }
    return { outcome: "cancelled" };
  }
}
