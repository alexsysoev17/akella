import { CodexAdapter } from "./codex.js";
import { registerProvider, registeredProvider } from "./types.js";
registerProvider("codex-sdk", (dir) => new CodexAdapter("codex-sdk", dir));
registerProvider("codex-cli", (dir) => new CodexAdapter("codex-cli", dir));
export const createProvider = registeredProvider;
export * from "./types.js";
