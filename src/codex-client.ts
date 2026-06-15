/**
 * Minimal Codex app-server client.
 *
 * Adapted (trimmed) from raroque/boop-agent's codex-app-server.ts (Apache-2.0).
 * Spawns `codex app-server` over stdio, speaks JSON-RPC 2.0 line-delimited,
 * drives a single thread+turn, streams agentMessage deltas, and dispatches
 * Codex's `item/tool/call` requests back to local dynamic-tool handlers
 * (this is how Codex -> Claude works: register an `ask_claude` dynamic tool).
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import readline from "node:readline";

export interface CodexDynamicTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handle: (args: Record<string, unknown>) => Promise<string>;
}

export interface CodexRunEvents {
  onText?: (delta: string) => void;
  onToolCall?: (tool: string, args: unknown) => void;
  onToolResult?: (tool: string, text: string) => void;
  onReasoning?: (delta: string) => void;
}

export interface CodexRunOptions {
  prompt: string;
  cwd: string;
  /** "read-only" is the safe default; "workspace-write" lets Codex edit files in cwd. */
  sandbox?: "read-only" | "workspace-write";
  developerInstructions?: string;
  tools?: CodexDynamicTool[];
  events?: CodexRunEvents;
}

type Pending = { resolve: (v: any) => void; reject: (e: unknown) => void };

export class CodexClient {
  private child: ChildProcessWithoutNullStreams | null = null;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private tools = new Map<string, CodexDynamicTool>();
  private reply = "";
  private currentItemId = "";
  private turnDone: { resolve: () => void; reject: (e: unknown) => void } | null = null;
  private events: CodexRunEvents = {};

  async run(opts: CodexRunOptions): Promise<{ text: string }> {
    this.events = opts.events ?? {};
    this.reply = "";
    this.currentItemId = "";
    this.tools = new Map((opts.tools ?? []).map((t) => [t.name, t]));

    // Auth: default is your ChatGPT/Codex subscription login (~/.codex/auth.json).
    // If OPENAI_API_KEY is set, force API-key billing — without the override
    // codex keeps preferring the chatgpt-mode auth.json even when a key exists.
    const codexArgs = ["app-server"];
    if (process.env.OPENAI_API_KEY) {
      codexArgs.push("-c", 'preferred_auth_method="apikey"');
    }
    this.child = spawn("codex", codexArgs, {
      cwd: opts.cwd,
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    const rl = readline.createInterface({ input: this.child.stdout });
    rl.on("line", (line) => this.onLine(line));
    this.child.stderr.on("data", (c) => {
      const t = c.toString().trim();
      if (t && !t.includes("ignoring") && !t.includes("failed to load skill")) {
        console.warn(`[codex] ${t}`);
      }
    });
    this.child.on("exit", (code, sig) => {
      const err = new Error(`codex app-server exited (${code ?? sig ?? "?"})`);
      for (const p of this.pending.values()) p.reject(err);
      this.pending.clear();
      this.turnDone?.reject(err);
      this.turnDone = null;
    });

    try {
      await this.call("initialize", {
        clientInfo: { name: "cc-codex-bridge", title: "CC<->Codex Bridge", version: "0.1.0" },
        capabilities: { experimentalApi: true },
      });
      this.notify("initialized", {});

      const thread: any = await this.call("thread/start", {
        cwd: opts.cwd,
        approvalPolicy: "never",
        sandbox: opts.sandbox ?? "read-only",
        ephemeral: true,
        developerInstructions: opts.developerInstructions,
        dynamicTools: (opts.tools ?? []).map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema as any,
        })),
      });
      const threadId = String(thread.thread.id);

      const turnWait = new Promise<void>((resolve, reject) => {
        this.turnDone = { resolve, reject };
      });
      await this.call("turn/start", {
        threadId,
        input: [{ type: "text", text: opts.prompt, text_elements: [] }],
        approvalPolicy: "never",
        sandboxPolicy:
          (opts.sandbox ?? "read-only") === "workspace-write"
            ? { type: "workspaceWrite", networkAccess: false }
            : { type: "readOnly" },
      });
      await turnWait;
      return { text: this.reply };
    } finally {
      rl.close();
      await this.close();
    }
  }

  private call(method: string, params: unknown): Promise<any> {
    if (!this.child) throw new Error("codex app-server not running");
    const id = this.nextId++;
    const p = new Promise<any>((resolve, reject) => this.pending.set(id, { resolve, reject }));
    this.write({ id, method, params });
    return p;
  }

  private notify(method: string, params: unknown): void {
    this.write({ method, params });
  }

  private respond(id: number, result: unknown): void {
    this.write({ id, result });
  }

  private write(msg: unknown): void {
    this.child?.stdin.write(`${JSON.stringify(msg)}\n`);
  }

  private onLine(line: string): void {
    const raw = line.trim();
    if (!raw) return;
    let msg: any;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    // JSON-RPC response to one of our calls
    if (typeof msg.id === "number" && !msg.method) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new Error(JSON.stringify(msg.error)));
      else p.resolve(msg.result ?? {});
      return;
    }

    // Server -> client request (tool calls, approvals, ...)
    if (typeof msg.id === "number" && msg.method) {
      void this.onServerRequest(msg);
      return;
    }

    // Notifications
    this.onNotification(msg);
  }

  private onNotification(msg: any): void {
    switch (msg.method) {
      case "item/agentMessage/delta": {
        const { delta, itemId } = msg.params;
        if (itemId && itemId !== this.currentItemId) {
          this.currentItemId = itemId;
          this.reply = "";
        }
        this.reply += delta;
        this.events.onText?.(delta);
        break;
      }
      case "item/reasoning/summaryTextDelta":
      case "item/reasoning/textDelta":
        this.events.onReasoning?.(msg.params.delta ?? "");
        break;
      case "turn/completed":
        this.turnDone?.resolve();
        this.turnDone = null;
        break;
      case "error":
        this.turnDone?.reject(new Error(JSON.stringify(msg.params?.error ?? msg.params)));
        this.turnDone = null;
        break;
    }
  }

  private async onServerRequest(msg: any): Promise<void> {
    try {
      switch (msg.method) {
        case "item/tool/call": {
          const toolName: string = msg.params.tool;
          const tool = this.tools.get(toolName);
          if (!tool) {
            this.respond(msg.id, {
              success: false,
              contentItems: [{ type: "inputText", text: `Unknown tool ${toolName}` }],
            });
            return;
          }
          const args =
            msg.params.arguments && typeof msg.params.arguments === "object"
              ? (msg.params.arguments as Record<string, unknown>)
              : {};
          this.events.onToolCall?.(toolName, args);
          const text = await tool.handle(args);
          this.events.onToolResult?.(toolName, text);
          this.respond(msg.id, {
            success: true,
            contentItems: [{ type: "inputText", text }],
          });
          return;
        }
        // Auto-handle approvals so a headless run never blocks.
        case "item/commandExecution/requestApproval":
        case "item/fileChange/requestApproval":
        case "applyPatchApproval":
        case "execCommandApproval":
          this.respond(msg.id, { decision: "decline" });
          return;
        case "item/permissions/requestApproval":
          this.respond(msg.id, { permissions: {}, scope: "turn", strictAutoReview: true });
          return;
        case "item/tool/requestUserInput":
          this.respond(msg.id, { answers: {} });
          return;
        default:
          this.respond(msg.id, null);
      }
    } catch (err) {
      this.respond(msg.id, {
        success: false,
        contentItems: [{ type: "inputText", text: String(err) }],
      });
    }
  }

  private async close(): Promise<void> {
    const child = this.child;
    this.child = null;
    if (!child) return;
    if (!child.killed) child.kill();
    await Promise.race([
      once(child, "exit").catch(() => undefined),
      new Promise((r) => setTimeout(r, 1000)),
    ]);
  }
}

export async function runCodexTurn(opts: CodexRunOptions): Promise<{ text: string }> {
  return new CodexClient().run(opts);
}
