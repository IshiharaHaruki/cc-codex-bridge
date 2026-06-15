/**
 * Minimal Codex app-server client.
 *
 * Adapted (trimmed) from raroque/boop-agent's codex-app-server.ts (Apache-2.0).
 * Spawns `codex app-server` over stdio, speaks JSON-RPC 2.0 line-delimited,
 * drives a single thread+turn, streams agentMessage deltas, and dispatches
 * Codex's `item/tool/call` requests back to local dynamic-tool handlers
 * (this is how Codex -> Claude works: register an `ask_claude` dynamic tool).
 *
 * Typed against the generated app-server protocol in ./codex-protocol
 * (regenerate with `npm run codex:protocol` after a codex upgrade).
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import readline from "node:readline";

import type { InitializeParams } from "./codex-protocol/InitializeParams.js";
import type { InitializeResponse } from "./codex-protocol/InitializeResponse.js";
import type { RequestId } from "./codex-protocol/RequestId.js";
import type { ServerNotification } from "./codex-protocol/ServerNotification.js";
import type { ServerRequest } from "./codex-protocol/ServerRequest.js";
import type { JsonValue } from "./codex-protocol/serde_json/JsonValue.js";
import type { DynamicToolCallResponse } from "./codex-protocol/v2/DynamicToolCallResponse.js";
import type { DynamicToolSpec } from "./codex-protocol/v2/DynamicToolSpec.js";
import type { SandboxPolicy } from "./codex-protocol/v2/SandboxPolicy.js";
import type { ThreadStartParams } from "./codex-protocol/v2/ThreadStartParams.js";
import type { ThreadStartResponse } from "./codex-protocol/v2/ThreadStartResponse.js";
import type { TurnStartParams } from "./codex-protocol/v2/TurnStartParams.js";
import type { TurnStartResponse } from "./codex-protocol/v2/TurnStartResponse.js";
import type { UserInput } from "./codex-protocol/v2/UserInput.js";

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

export interface CodexRunResult {
  text: string;
}

/** Typed request/response map for the JSON-RPC calls this client makes. */
interface RequestMap {
  initialize: { params: InitializeParams; result: InitializeResponse };
  "thread/start": { params: ThreadStartParams; result: ThreadStartResponse };
  "turn/start": { params: TurnStartParams; result: TurnStartResponse };
}
type RequestMethod = keyof RequestMap;

/** A JSON-RPC success/error response to one of our outbound calls. */
interface JsonRpcResponse {
  id: RequestId;
  result?: unknown;
  error?: { message?: string } | null;
}

type Inbound = JsonRpcResponse | ServerRequest | ServerNotification;

interface Pending {
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
}

interface TurnCompletion {
  resolve: () => void;
  reject: (reason: unknown) => void;
}

export class CodexClient {
  private child: ChildProcessWithoutNullStreams | null = null;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private tools = new Map<string, CodexDynamicTool>();
  private reply = "";
  private currentItemId = "";
  private turnDone: TurnCompletion | null = null;
  private events: CodexRunEvents = {};

  async run(opts: CodexRunOptions): Promise<CodexRunResult> {
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
    this.child.stderr.on("data", (c: Buffer) => {
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
        capabilities: { experimentalApi: true, requestAttestation: false },
      });
      this.notifyInitialized();

      const dynamicTools: DynamicToolSpec[] = (opts.tools ?? []).map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema as JsonValue,
      }));

      const threadStartParams: ThreadStartParams = {
        cwd: opts.cwd,
        approvalPolicy: "never",
        sandbox: opts.sandbox === "workspace-write" ? "workspace-write" : "read-only",
        ephemeral: true,
        developerInstructions: opts.developerInstructions ?? null,
        dynamicTools,
      };
      const thread = await this.call("thread/start", threadStartParams);
      const threadId = thread.thread.id;

      const turnWait = new Promise<void>((resolve, reject) => {
        this.turnDone = { resolve, reject };
      });
      const input: UserInput[] = [{ type: "text", text: opts.prompt, text_elements: [] }];
      const turnStartParams: TurnStartParams = {
        threadId,
        input,
        approvalPolicy: "never",
        sandboxPolicy: this.sandboxPolicy(opts),
      };
      await this.call("turn/start", turnStartParams);
      await turnWait;
      return { text: this.reply };
    } finally {
      rl.close();
      await this.close();
    }
  }

  private sandboxPolicy(opts: CodexRunOptions): SandboxPolicy {
    if (opts.sandbox === "workspace-write") {
      return {
        type: "workspaceWrite",
        writableRoots: [opts.cwd],
        networkAccess: false,
        excludeTmpdirEnvVar: false,
        excludeSlashTmp: false,
      };
    }
    return { type: "readOnly", networkAccess: false };
  }

  private call<M extends RequestMethod>(
    method: M,
    params: RequestMap[M]["params"],
  ): Promise<RequestMap[M]["result"]> {
    if (!this.child) throw new Error("codex app-server is not running");
    const id = this.nextId++;
    const promise = new Promise<RequestMap[M]["result"]>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
    });
    this.write({ id, method, params });
    return promise;
  }

  private notifyInitialized(): void {
    this.write({ method: "initialized", params: {} });
  }

  private respond(id: RequestId, result: unknown): void {
    this.write({ id, result });
  }

  private write(msg: unknown): void {
    this.child?.stdin.write(`${JSON.stringify(msg)}\n`);
  }

  private onLine(line: string): void {
    const raw = line.trim();
    if (!raw) return;
    let msg: Inbound & { id?: RequestId; method?: string };
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    // JSON-RPC response to one of our outbound calls (has id, no method).
    if (msg.id !== undefined && !msg.method) {
      const response = msg as JsonRpcResponse;
      if (typeof response.id !== "number") return;
      const p = this.pending.get(response.id);
      if (!p) return;
      this.pending.delete(response.id);
      if (response.error) p.reject(new Error(response.error.message ?? JSON.stringify(response.error)));
      else p.resolve(response.result ?? {});
      return;
    }

    // Server -> client request (has both id and method).
    if (msg.id !== undefined && msg.method) {
      void this.onServerRequest(msg as ServerRequest);
      return;
    }

    // Server -> client notification (method, no id).
    if (msg.method) this.onNotification(msg as ServerNotification);
  }

  private onNotification(n: ServerNotification): void {
    switch (n.method) {
      case "item/agentMessage/delta": {
        const { delta, itemId } = n.params;
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
        this.events.onReasoning?.(n.params.delta);
        break;
      case "turn/completed":
        this.turnDone?.resolve();
        this.turnDone = null;
        break;
      case "error":
        this.turnDone?.reject(new Error(JSON.stringify(n.params.error)));
        this.turnDone = null;
        break;
    }
  }

  private async onServerRequest(r: ServerRequest): Promise<void> {
    try {
      switch (r.method) {
        case "item/tool/call": {
          const toolName = r.params.tool;
          const tool = this.tools.get(toolName);
          if (!tool) {
            const miss: DynamicToolCallResponse = {
              success: false,
              contentItems: [{ type: "inputText", text: `Unknown tool ${toolName}` }],
            };
            this.respond(r.id, miss);
            return;
          }
          const rawArgs = r.params.arguments;
          const args: Record<string, unknown> =
            rawArgs && typeof rawArgs === "object" && !Array.isArray(rawArgs)
              ? (rawArgs as Record<string, unknown>)
              : {};
          this.events.onToolCall?.(toolName, args);
          const text = await tool.handle(args);
          this.events.onToolResult?.(toolName, text);
          const ok: DynamicToolCallResponse = {
            success: true,
            contentItems: [{ type: "inputText", text }],
          };
          this.respond(r.id, ok);
          return;
        }
        // Auto-handle approvals so a headless run never blocks.
        case "item/commandExecution/requestApproval":
        case "item/fileChange/requestApproval":
        case "applyPatchApproval":
        case "execCommandApproval":
          this.respond(r.id, { decision: "decline" });
          return;
        case "item/permissions/requestApproval":
          this.respond(r.id, { permissions: {}, scope: "turn", strictAutoReview: true });
          return;
        case "item/tool/requestUserInput":
          this.respond(r.id, { answers: {} });
          return;
        default:
          this.respond(r.id, null);
      }
    } catch (err) {
      const fail: DynamicToolCallResponse = {
        success: false,
        contentItems: [{ type: "inputText", text: String(err) }],
      };
      this.respond(r.id, fail);
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

export async function runCodexTurn(opts: CodexRunOptions): Promise<CodexRunResult> {
  return new CodexClient().run(opts);
}
