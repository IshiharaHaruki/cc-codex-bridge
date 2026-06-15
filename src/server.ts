/**
 * Minimal localhost web bridge between Claude (Agent SDK) and Codex (app-server).
 *
 *   Browser  ──>  POST /api/ask {agent, prompt}  ──>  NDJSON event stream
 *
 *   agent="claude": runs Claude; Claude can call `codex_delegate` (CC -> Codex)
 *   agent="codex" : runs Codex;  Codex can call `ask_claude`     (Codex -> CC)
 *
 * Both directions are user-triggered (you pick the agent in the UI).
 */
import http from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { runClaude } from "./claude-runtime.js";
import { runCodexTurn, type CodexDynamicTool } from "./codex-client.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const PORT = Number(process.env.PORT ?? 4399);

// cwd both agents operate in — defaults to this project's parent folder (PH).
const CWD = process.env.BRIDGE_CWD ?? join(ROOT, "..");

function send(res: http.ServerResponse, type: string, data: unknown) {
  res.write(JSON.stringify({ type, data }) + "\n");
}

const askClaudeTool = (): CodexDynamicTool => ({
  name: "ask_claude",
  description:
    "Ask Claude (Anthropic) a question and get its answer. Use for a second opinion, " +
    "design review, or to hand off reasoning-heavy sub-questions.",
  inputSchema: {
    type: "object",
    properties: { question: { type: "string", description: "The question for Claude" } },
    required: ["question"],
    additionalProperties: false,
  },
  handle: async (args) => {
    const res = await runClaude({
      prompt: String(args.question ?? ""),
      cwd: CWD,
      withCodexTool: false, // no recursion back into Codex
    });
    return res.text || "(Claude returned no text)";
  },
});

async function handleAsk(req: http.IncomingMessage, res: http.ServerResponse) {
  let body = "";
  for await (const chunk of req) body += chunk;
  let parsed: { agent?: string; prompt?: string };
  try {
    parsed = JSON.parse(body || "{}");
  } catch {
    res.writeHead(400).end("bad json");
    return;
  }
  const agent = parsed.agent === "codex" ? "codex" : "claude";
  const prompt = (parsed.prompt ?? "").trim();
  if (!prompt) {
    res.writeHead(400).end("empty prompt");
    return;
  }

  res.writeHead(200, {
    "Content-Type": "application/x-ndjson; charset=utf-8",
    "Cache-Control": "no-cache",
  });
  send(res, "start", { agent, cwd: CWD });

  try {
    if (agent === "claude") {
      await runClaude({
        prompt,
        cwd: CWD,
        withCodexTool: true,
        events: {
          onText: (d) => send(res, "text", d),
          onToolCall: (t, a) => send(res, "tool_call", { tool: t, args: a }),
          onToolResult: (t, txt) => send(res, "tool_result", { tool: t, text: txt }),
        },
      });
    } else {
      await runCodexTurn({
        prompt,
        cwd: CWD,
        sandbox: "read-only",
        tools: [askClaudeTool()],
        events: {
          onText: (d) => send(res, "text", d),
          onReasoning: (d) => send(res, "reasoning", d),
          onToolCall: (t, a) => send(res, "tool_call", { tool: t, args: a }),
          onToolResult: (t, txt) => send(res, "tool_result", { tool: t, text: txt }),
        },
      });
    }
    send(res, "done", {});
  } catch (err) {
    send(res, "error", String(err));
  } finally {
    res.end();
  }
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === "POST" && req.url === "/api/ask") {
      await handleAsk(req, res);
      return;
    }
    if (req.method === "GET" && (req.url === "/" || req.url === "/index.html")) {
      const html = await readFile(join(ROOT, "public", "index.html"), "utf8");
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(html);
      return;
    }
    res.writeHead(404).end("not found");
  } catch (err) {
    res.writeHead(500).end(String(err));
  }
});

server.listen(PORT, () => {
  console.log(`\n  cc-codex-bridge running:  http://localhost:${PORT}`);
  console.log(`  cwd for both agents:      ${CWD}\n`);
});
