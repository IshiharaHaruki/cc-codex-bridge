/**
 * Claude Agent SDK runtime.
 *
 * - runClaude(): drives a single query(), streaming assistant text + tool events.
 * - When `withCodexTool` is true, Claude gets an in-process `codex_delegate`
 *   tool (this is how Claude -> Codex works): the handler runs a Codex turn
 *   via the app-server client and returns Codex's answer.
 */
import { createSdkMcpServer, query, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { runCodexTurn } from "./codex-client.js";

export interface ClaudeRunEvents {
  onText?: (delta: string) => void;
  onToolCall?: (tool: string, args: unknown) => void;
  onToolResult?: (tool: string, text: string) => void;
}

export interface ClaudeRunOptions {
  prompt: string;
  cwd: string;
  withCodexTool?: boolean;
  events?: ClaudeRunEvents;
}

export async function runClaude(opts: ClaudeRunOptions): Promise<{ text: string }> {
  const ev = opts.events ?? {};

  const mcpServers: Record<string, unknown> = {};
  const allowedTools: string[] = [];

  if (opts.withCodexTool) {
    const codexServer = createSdkMcpServer({
      name: "codex",
      version: "0.1.0",
      tools: [
        tool(
          "codex_delegate",
          "Delegate a coding/analysis task to OpenAI Codex (read-only) and return its result. " +
            "Use this for a second opinion, an independent review, or to hand off focused work.",
          {
            task: z.string().describe("The full task or question for Codex"),
          },
          async (args) => {
            let buf = "";
            try {
              const res = await runCodexTurn({
                prompt: args.task,
                cwd: opts.cwd,
                sandbox: "read-only",
                events: { onText: (d) => (buf += d) },
              });
              const text = res.text || buf || "(Codex returned no text)";
              return { content: [{ type: "text" as const, text }] };
            } catch (err) {
              return {
                content: [{ type: "text" as const, text: `Codex delegation failed: ${String(err)}` }],
                isError: true,
              };
            }
          },
        ),
      ],
    });
    mcpServers.codex = codexServer;
    allowedTools.push("mcp__codex__codex_delegate");
  }

  let text = "";
  let lastAssistant = "";

  // Auth: default is your Claude subscription login (Claude Code oauth).
  // If ANTHROPIC_API_KEY is set, pass it through so the SDK uses API billing.
  const apiKey = process.env.ANTHROPIC_API_KEY;
  const env = apiKey ? { ...process.env, ANTHROPIC_API_KEY: apiKey } : undefined;

  for await (const msg of query({
    prompt: opts.prompt,
    options: {
      cwd: opts.cwd,
      mcpServers: mcpServers as any,
      allowedTools,
      permissionMode: "bypassPermissions",
      ...(env ? { env } : {}),
    },
  })) {
    if (msg.type === "assistant") {
      let chunk = "";
      for (const block of msg.message.content) {
        if (block.type === "text") {
          text += block.text;
          chunk += block.text;
          ev.onText?.(block.text);
        } else if (block.type === "tool_use") {
          ev.onToolCall?.(block.name, block.input);
        }
      }
      if (chunk.trim()) lastAssistant = chunk;
    } else if (msg.type === "user") {
      for (const block of msg.message.content) {
        if (typeof block !== "string" && (block as any).type === "tool_result") {
          const c = (block as any).content;
          const resultText = Array.isArray(c)
            ? c.map((x: any) => (typeof x === "string" ? x : x?.text ?? "")).join("")
            : String(c ?? "");
          ev.onToolResult?.("tool_result", resultText);
        }
      }
    }
  }

  return { text: lastAssistant || text };
}
