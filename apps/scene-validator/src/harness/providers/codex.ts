import { redactSecrets, redact } from "../security.js";
import { validateProviderSchema } from "./schema.js";
import { Codex } from "@openai/codex-sdk";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { spawn } from "node:child_process";
import { access, readFile, writeFile, chmod } from "node:fs/promises";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {StringDecoder} from "node:string_decoder";
import {homedir} from 'node:os';
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
  async contextProfile(model?:string){
    // Metadata only: never read auth.json or transmit local configuration.
    try{
      const home=process.env.CODEX_HOME||path.join(homedir(),'.codex');
      const requested=model||((await readFile(path.join(home,'config.toml'),'utf8')).split(/^\[/m)[0].match(/^model\s*=\s*"([a-zA-Z0-9_.:/-]+)"/m)?.[1]);
      if(!requested)return undefined;
      const cache=JSON.parse(await readFile(path.join(home,'models_cache.json'),'utf8'));
      const age=Date.now()-Date.parse(cache.fetched_at);if(!Number.isFinite(age)||age>7*86400000||age< -86400000)return undefined;
      const entry=cache.models?.find((e:{slug:string})=>e.slug===requested);
      const window=entry?.context_window;
      if(!Number.isSafeInteger(window)||window<4000||window>4000000)return undefined;
      return {provider:this.id,model:requested,contextWindowTokens:window,maxOutputTokens:16000,transportOverheadTokens:32768,reasoningReserveTokens:8192,source:'local Codex model metadata, window as configured (not max_context_window); output reserve is AKELLA policy, native cap unsupported'};
    }catch{return undefined;}
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
    validateProviderSchema(req.responseSchema);
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
      if (this.id === "codex-sdk" && process.platform !== "win32") {
        const codex = new Codex({
          codexPathOverride: await sdkTransportBinary(this.directory),
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
        if(!result.usage)throw new ProviderError("OUTPUT_TRUNCATED","Stream ended before turn.completed; response cannot be committed");
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
        if(!events.some(e=>e.type==="turn.completed"))throw new ProviderError("OUTPUT_TRUNCATED","CLI stream ended before turn.completed");
        response = await readFile(
          path.join(this.directory, "response.txt"),
          "utf8",
        );
      }
      await writeFile(
        path.join(this.directory, "raw-response.json"),
        redactSecrets(response),
      );
      let output: unknown;
      try { output = JSON.parse(response); } catch(error) {
        throw new ProviderError(/Unexpected end|Unterminated/i.test(String(error)) ? "OUTPUT_TRUNCATED" : "PROVIDER_JSON_INVALID", "Completed provider message is not valid JSON: " + String(error));
      }
      const result: ProviderResponse = {
        output,
        usage,
        estimatedCost: null,
        latencyMs: performance.now() - started,
        diagnostics: [
          "Codex does not expose a native output-token cap here; budget checked after response",
          "Price unavailable: estimatedCost=null",
          process.platform === "win32" ? "Windows: SDK selection uses the existing CLI transport with UTF-8/LF framing" : "SDK JSONL Unicode framing guard: U+2028/U+2029 escaped without changing decoded content",
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
        throw new ProviderError("PROVIDER_TIMEOUT", "Provider time budget exceeded");
      if (e instanceof ProviderError) throw e;
      const transport = /Failed to parse item:/.test(String(e)) ? "PROVIDER_EVENT_PARSE_ERROR" : transportErrorCode(e);
      throw new ProviderError(
        e instanceof SyntaxError ? "INVALID_OUTPUT" : transport === "TRANSPORT" ? "PROVIDER_TRANSPORT_ERROR" : transport === "AUTH_REQUIRED" ? "PROVIDER_AUTH_FAILED" : transport === "TIMEOUT" ? "PROVIDER_TIMEOUT" : transport,
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
    const decoder = new StringDecoder("utf8");
    let output = "",
      error = "";
    const abort = () => child.kill("SIGTERM");
    signal.addEventListener("abort", abort, { once: true });
    child.stdout.on("data", (b) => {
      output += decoder.write(b);
      if (output.length > 4_000_000) {
        child.kill("SIGTERM");
        reject(new ProviderError("INVALID_OUTPUT", "Response exceeds 4MB"));
      }
    });
    child.stderr.on("data", (b) => (error = (error + b).slice(-4000)));
    child.on("error", reject);
    child.on("close", (code) => {
      signal.removeEventListener("abort", abort);
      output += decoder.end();
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
        reject(new ProviderError("PROVIDER_EVENT_PARSE_ERROR", "Invalid CLI JSONL envelope: " + String(e)));
      }
    });
    child.stdin.on("error", () => {});
    child.stdin.end(prompt);
  });
}

/** Keep the installed SDK and its lifecycle; shield only its line framing. */
export async function sdkTransportBinary(directory: string) {
  if (process.platform === "win32") throw new ProviderError("UNSUPPORTED_CAPABILITY", "SDK Unicode framing proxy requires POSIX; select codex-cli transport on Windows");
  const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
  const file = path.join(directory, "sdk-transport.sh");
  const proxy = fileURLToPath(new URL("./codex-stream-proxy.mjs", import.meta.url));
  await writeFile(file, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(proxy)} ${quote(await codexBinary())} "$@"\n`, {mode:0o700});
  await chmod(file,0o700);
  return file;
}
