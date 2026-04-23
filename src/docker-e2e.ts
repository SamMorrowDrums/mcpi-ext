import { spawn } from "node:child_process";
import type {
  AgentToolResult,
  AgentToolUpdateCallback,
  ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import { Type, type Static } from "typebox";

const DOCKER_IMAGE = "pi-mcp-agent-e2e";

const DockerE2EParams = Type.Object({
  task: Type.String({ description: "The task/prompt to run inside the sandbox" }),
  token: Type.String({
    description: "GitHub token for Copilot model access",
  }),
  model: Type.Optional(
    Type.String({
      description:
        "Model to use (e.g. claude-sonnet-4-5). Defaults to the provider default.",
    })
  ),
  timeout: Type.Optional(
    Type.Number({
      description: "Timeout in seconds. Defaults to 300 (5 minutes).",
    })
  ),
});

type DockerE2EInput = Static<typeof DockerE2EParams>;

interface RunLogEntry {
  type: string;
  timestamp: number;
  raw: string;
}

export interface DockerE2EDetails {
  exitCode: number | null;
  log: RunLogEntry[];
  duration: number;
  model?: string;
  usage?: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    cost: number;
    turns: number;
  };
}

export function parseJsonlLine(line: string): RunLogEntry | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed);
    return { type: parsed.type ?? "unknown", timestamp: Date.now(), raw: trimmed };
  } catch {
    return { type: "raw", timestamp: Date.now(), raw: trimmed };
  }
}

export function extractAssistantText(log: RunLogEntry[]): string {
  const parts: string[] = [];
  for (const entry of log) {
    if (entry.type !== "message_end") continue;
    try {
      const event = JSON.parse(entry.raw);
      const msg = event.message;
      if (msg?.role !== "assistant") continue;
      for (const part of msg.content ?? []) {
        if (part.type === "text") parts.push(part.text);
      }
    } catch {
      // skip malformed
    }
  }
  return parts.join("\n");
}

export function extractUsage(log: RunLogEntry[]) {
  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };
  for (const entry of log) {
    if (entry.type !== "message_end") continue;
    try {
      const event = JSON.parse(entry.raw);
      const msg = event.message;
      if (msg?.role !== "assistant") continue;
      usage.turns++;
      const u = msg.usage;
      if (u) {
        usage.input += u.input ?? 0;
        usage.output += u.output ?? 0;
        usage.cacheRead += u.cacheRead ?? 0;
        usage.cacheWrite += u.cacheWrite ?? 0;
        usage.cost += u.cost?.total ?? 0;
      }
    } catch {
      // skip
    }
  }
  return usage;
}

export function extractModel(log: RunLogEntry[]): string | undefined {
  for (const entry of log) {
    if (entry.type !== "message_end") continue;
    try {
      const event = JSON.parse(entry.raw);
      if (event.message?.model) return event.message.model as string;
    } catch {
      // skip
    }
  }
  return undefined;
}

export function buildDockerArgs(
  image: string,
  params: DockerE2EInput
): string[] {
  const args = [
    "run",
    "--rm",
    "-e",
    `GITHUB_TOKEN=${params.token}`,
  ];

  if (params.model) {
    args.push("-e", `PI_MODEL=${params.model}`);
  }

  args.push(image, params.task);
  return args;
}

export const dockerE2ETool = {
  name: "docker_e2e",
  label: "Docker E2E",
  description:
    "Run a task end-to-end inside an isolated Docker container with pi and this project's extensions. Returns the full run log for evaluation.",
  promptSnippet:
    "Run an isolated e2e task in Docker. Requires a GitHub token and task prompt.",
  parameters: DockerE2EParams,

  async execute(
    _toolCallId: string,
    params: DockerE2EInput,
    signal: AbortSignal | undefined,
    onUpdate: AgentToolUpdateCallback<DockerE2EDetails> | undefined,
    _ctx: ExtensionContext
  ): Promise<AgentToolResult<DockerE2EDetails>> {
    const startTime = Date.now();
    const timeoutMs = (params.timeout ?? 300) * 1000;
    const log: RunLogEntry[] = [];
    let lastAssistantText = "";

    const dockerArgs = buildDockerArgs(DOCKER_IMAGE, params);

    const exitCode = await new Promise<number | null>((resolve) => {
      const proc = spawn("docker", dockerArgs, {
        stdio: ["ignore", "pipe", "pipe"],
      });

      let buffer = "";
      let timedOut = false;
      let timeoutHandle: NodeJS.Timeout | undefined;

      if (timeoutMs > 0) {
        timeoutHandle = setTimeout(() => {
          timedOut = true;
          proc.kill("SIGTERM");
          setTimeout(() => {
            if (!proc.killed) proc.kill("SIGKILL");
          }, 5000);
        }, timeoutMs);
      }

      const processLine = (line: string) => {
        const entry = parseJsonlLine(line);
        if (!entry) return;
        log.push(entry);

        if (entry.type === "message_end") {
          const text = extractAssistantText(log);
          if (text) lastAssistantText = text;
        }

        onUpdate?.({
          content: [
            {
              type: "text",
              text: lastAssistantText || `(running… ${log.length} events)`,
            },
          ],
          details: {
            exitCode: null,
            log,
            duration: Date.now() - startTime,
            model: extractModel(log),
            usage: extractUsage(log),
          },
        });
      };

      proc.stdout.on("data", (data: Buffer) => {
        buffer += data.toString();
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) processLine(line);
      });

      proc.stderr.on("data", (data: Buffer) => {
        const text = data.toString().trim();
        if (text) {
          log.push({ type: "stderr", timestamp: Date.now(), raw: text });
        }
      });

      proc.on("close", (code) => {
        if (timeoutHandle) clearTimeout(timeoutHandle);
        if (buffer.trim()) processLine(buffer);
        if (timedOut) {
          log.push({
            type: "timeout",
            timestamp: Date.now(),
            raw: `Timed out after ${params.timeout ?? 300}s`,
          });
        }
        resolve(timedOut ? null : (code ?? 1));
      });

      proc.on("error", (err) => {
        if (timeoutHandle) clearTimeout(timeoutHandle);
        log.push({
          type: "error",
          timestamp: Date.now(),
          raw: err.message,
        });
        resolve(null);
      });

      if (signal) {
        const onAbort = () => {
          proc.kill("SIGTERM");
          setTimeout(() => {
            if (!proc.killed) proc.kill("SIGKILL");
          }, 5000);
        };
        if (signal.aborted) onAbort();
        else signal.addEventListener("abort", onAbort, { once: true });
      }
    });

    const duration = Date.now() - startTime;
    const assistantText = extractAssistantText(log);
    const usage = extractUsage(log);
    const model = extractModel(log);
    const fullLog = log.map((e) => e.raw).join("\n");

    const summary = [
      `## Docker E2E Run Complete`,
      ``,
      `**Exit code:** ${exitCode ?? "killed"}`,
      `**Duration:** ${(duration / 1000).toFixed(1)}s`,
      model ? `**Model:** ${model}` : null,
      usage.turns > 0
        ? `**Usage:** ${usage.turns} turns, ↑${usage.input} ↓${usage.output} tokens, $${usage.cost.toFixed(4)}`
        : null,
      ``,
      `### Output`,
      assistantText || "(no assistant output)",
      ``,
      `### Full Log (${log.length} events)`,
      "```",
      fullLog,
      "```",
    ]
      .filter((l) => l !== null)
      .join("\n");

    return {
      content: [{ type: "text", text: summary }],
      details: { exitCode, log, duration, model, usage },
    };
  },
};
