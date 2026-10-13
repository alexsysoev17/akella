/** Browser/server share IDs; labels are presentation only. */
export const PROVIDER_ID_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;
export const DEFAULT_PROVIDER_ID = "codex-sdk";
export const MANUAL_PROVIDER_ID = "manual-response";
export const PROVIDER_SETTINGS_MESSAGE =
  "Ошибка настройки AI-провайдера. Проверьте выбранную модель в настройках приложения.";
export const PROVIDER_LABELS: Record<string, string> = {
  "codex-sdk": "Codex SDK",
  "codex-cli": "Codex CLI",
  "manual-response": "Ручной обмен с Codex",
};
export const LEGACY_PROVIDER_ALIASES: Record<string, string> = {
  "Codex SDK": "codex-sdk",
  "Codex CLI": "codex-cli",
};
export function selectedProviderId(value: string, available: string[]) {
  if (
    !PROVIDER_ID_PATTERN.test(value) ||
    (!available.includes(value) && value !== MANUAL_PROVIDER_ID)
  )
    throw new Error(PROVIDER_SETTINGS_MESSAGE);
  return value;
}
