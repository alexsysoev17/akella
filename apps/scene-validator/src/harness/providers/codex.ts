import { redactSecrets, redact } from "../security.js";
import { Codex } from "@openai/codex-sdk";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { spawn } from "node:child_process";
import { access, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  ProviderError,
  transportErrorCode,
  type ProviderAdapter,
  type ProviderRequest,
  type ProviderResponse,
  type ProviderUsage,
} from "./types.js";
export const toolsDisabled = Object.fromEntries(
  [
    "shell_tool",
    "unified_exec",
    "apply_patch",
    "exec_policy",
    "multi_agent",
    "spawn_agent",
    "view_image",
    "skill_search",
    "code_mode_host",
  ].map((k) => [k, false]),
);
export async function codexBinary() {
  if (process.env.MOTION_CODEX_BIN) {
    await access(process.env.MOTION_CODEX_BIN);
    return process.env.MOTION_CODEX_BIN;
  }
  const bundled =
    "/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex";
  try {
    await access(bundled);
    return bundled;
  } catch {
    return "codex";
  }
}
export class CodexAdapter implements ProviderAdapter {
  readonly mode = "live" as const;
  constructor(
    public readonly id: "codex-sdk" | "codex-cli",
    private directory: string,
  ) {}
  capabilities() {
    return {
      structuredOutput: true,
      schemaDialect: "strict-json-schema" as const,
      nativeToolCalling: false,
      cancellation: true,
      usage: true,
      nativeOutputTokenLimit: false,
    };
  }
  async health() {
    try {
      const { stdout, stderr } = await promisify(execFile)(
        await codexBinary(),
        ["login", "status"],
        { timeout: 5000, maxBuffer: 100000 },
      );
      const authenticated = /Logged in/i.test(stdout + stderr);
      return {
        status: authenticated ? ("READY" as const) : ("AUTH_REQUIRED" as const),
        message: authenticated
          ? "Codex: авторизация подтверждена; доступ к модели проверяется запросом"
          : "Codex: требуется авторизация",
      };
    } catch {
      return {
        status: "UNAVAILABLE" as const,
        message: "Codex недоступен или проверка авторизации не завершена",
      };
    }
  }
  async generate(req: ProviderRequest): Promise<ProviderResponse> {
    if (req.tools?.length)
      throw new ProviderError(
        "UNSUPPORTED_CAPABILITY",
        "Codex runtime tools are intentionally disabled; use typed operations",
      );
    const started = performance.now(),
      signal = AbortSignal.any([
        req.signal ?? new AbortController().signal,
        AbortSignal.timeout(req.timeoutMs),
      ]);
    const prompt = req.messages
      .map((m) => `${m.role.toUpperCase()}:\n${m.content}`)
      .join("\n\n");
    await writeFile(
      path.join(this.directory, "request.txt"),
      redactSecrets(prompt),
    );
    await writeFile(
      path.join(this.directory, "output-schema.json"),
      JSON.stringify(req.responseSchema, null, 2),
    );
    let response: string,
      usage: ProviderUsage | null = null;
    try {
      if (this.id === "codex-sdk") {
        const codex = new Codex({
          codexPathOverride: await codexBinary(),
          config: {
            features: toolsDisabled,
            web_search: "disabled",
            project_doc_max_bytes: 0,
          },
          configOverrides: ["mcp_servers={}", "plugins={}"],
        });
        const result = await codex
          .startThread({
            model: req.model || undefined,
            modelReasoningEffort: req.reasoningEffort,
            workingDirectory: this.directory,
            sandboxMode: "read-only",
            approvalPolicy: "never",
            skipGitRepoCheck: true,
            networkAccessEnabled: false,
            webSearchMode: "disabled",
          })
          .run(prompt, { outputSchema: req.responseSchema, signal });
        if (
          result.items.some((i) =>
            [
              "command_execution",
              "file_change",
              "mcp_tool_call",
              "web_search",
            ].includes(i.type),
          )
        )
          throw new ProviderError(
            "UNSUPPORTED_CAPABILITY",
            "Response used forbidden runtime tools",
          );
        response = result.finalResponse;
        if (result.usage)
          usage = {
            inputTokens: result.usage.input_tokens,
            outputTokens: result.usage.output_tokens,
            cachedInputTokens: result.usage.cached_input_tokens,
          };
      } else {
        const args = [
          "exec",
          "--json",
          "--ignore-user-config",
          "--skip-git-repo-check",
          "--ephemeral",
          "--sandbox",
          "read-only",
          "--cd",
          this.directory,
          "--output-schema",
          path.join(this.directory, "output-schema.json"),
          "-o",
          path.join(this.directory, "response.txt"),
          "-c",
          'approval_policy="never"',
          "-c",
          'web_search="disabled"',
          "-c",
          "project_doc_max_bytes=0",
        ];
        for (const key of Object.keys(toolsDisabled))
          args.push("-c", `features.${key}=false`);
        if (req.model) args.push("--model", req.model);
        if (req.reasoningEffort) args.push("-c", `model_reasoning_effort="${req.reasoningEffort}"`);
        args.push("-");
        const events = await cli(await codexBinary(), args, prompt, signal);
        for (const event of events) {
          if (
            [
              "command_execution",
              "file_change",
              "mcp_tool_call",
              "web_search",
            ].includes(event.item?.type ?? "")
          )
            throw new ProviderError(
              "UNSUPPORTED_CAPABILITY",
              "CLI used forbidden tools",
            );
          if (event.type === "turn.completed" && event.usage)
            usage = {
              inputTokens: event.usage.input_tokens,
              outputTokens: event.usage.output_tokens,
              cachedInputTokens: event.usage.cached_input_tokens,
            };
        }
        response = await readFile(
          path.join(this.directory, "response.txt"),
          "utf8",
        );
      }
      await writeFile(
        path.join(this.directory, "raw-response.json"),
        redactSecrets(response),
      );
      const result: ProviderResponse = {
        output: JSON.parse(response),
        usage,
        estimatedCost: null,
        latencyMs: performance.now() - started,
        diagnostics: [
          "Codex does not expose a native output-token cap here; budget checked after response",
          "Price unavailable: estimatedCost=null",
        ],
        toolCalls: [],
      };
      await writeFile(
        path.join(this.directory, "provider-trace.json"),
        JSON.stringify(
          {
            provider: this.id,
            model: req.model || "codex-default",
            ...result,
            output: undefined,
          },
          null,
          2,
        ),
      );
      return result;
    } catch (e) {
      if (req.signal?.aborted)
        throw new ProviderError("CANCELLED", "Run cancelled");
      if (signal.aborted)
        throw new ProviderError("TIMEOUT", "Provider time budget exceeded");
      if (e instanceof ProviderError) throw e;
      throw new ProviderError(
        e instanceof SyntaxError ? "INVALID_OUTPUT" : transportErrorCode(e),
        String(e),
      );
    }
  }
}
interface CliEvent {
  type?: string;
  item?: { type?: string };
  usage?: {
    input_tokens: number;
    output_tokens: number;
    cached_input_tokens?: number;
  };
}
function cli(
  binary: string,
  args: string[],
  prompt: string,
  signal: AbortSignal,
) {
  return new Promise<CliEvent[]>((resolve, reject) => {
    signal.throwIfAborted();
    const child = spawn(binary, args, {
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
    });
    let output = "",
      error = "";
    const abort = () => child.kill("SIGTERM");
    signal.addEventListener("abort", abort, { once: true });
    child.stdout.on("data", (b) => {
      output += b;
      if (output.length > 4_000_000) {
        child.kill("SIGTERM");
        reject(new ProviderError("INVALID_OUTPUT", "Response exceeds 4MB"));
      }
    });
    child.stderr.on("data", (b) => (error = (error + b).slice(-4000)));
    child.on("error", reject);
    child.on("close", (code) => {
      signal.removeEventListener("abort", abort);
      if (code !== 0) return reject(new Error(`Codex CLI ${code}: ${error}`));
      try {
        resolve(
          output
            .trim()
            .split("\n")
            .filter(Boolean)
            .map((l) => JSON.parse(l)),
        );
      } catch (e) {
        reject(e);
      }
    });
    child.stdin.on("error", () => {});
    child.stdin.end(prompt);
  });
}
