import type { ChatSettings, ModelPreference, Provider } from "./types";
import { catalogModel, getCatalogModels, type ModelOption } from "./api/model-catalog";

/** A user-set context window is usable only when it is a positive whole number. */
export function validContextWindow(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 1000
    ? Math.floor(value)
    : undefined;
}

/** A model is enabled unless the user explicitly turned it off. */
export function modelEnabled(settings: ChatSettings, model: string): boolean {
  return settings.modelPreferences?.[model]?.enabled !== false;
}

/** The catalog model with the user's local context-window override applied. */
export function effectiveModelOption(
  settings: ChatSettings,
  provider: Provider = settings.provider,
  model: string = settings.model,
  identity?: string,
): ModelOption | undefined {
  const saved = identity
    ? settings.modelCatalog?.entries.find((entry) => entry.provider === provider && entry.identity === identity)
      ?.models.find((item) => item.value === model)
    : undefined;
  const option = saved
    ?? catalogModel(provider, model)
    ?? settings.modelCatalog?.entries
      .filter((entry) => entry.provider === provider)
      .flatMap((entry) => entry.models)
      .find((item) => item.value === model);
  if (!option) return undefined;
  const contextWindow = validContextWindow(settings.modelPreferences?.[model]?.contextWindow);
  return contextWindow === undefined ? option : { ...option, contextWindow };
}

/** The API window, unless the user set a local override. */
export function effectiveContextWindow(
  settings: ChatSettings,
  provider: Provider = settings.provider,
  model: string = settings.model,
  identity?: string,
): number | undefined {
  return effectiveModelOption(settings, provider, model, identity)?.contextWindow;
}

/** The API value the model preference can restore to. */
export function catalogContextWindow(provider: Provider, model: string): number | undefined {
  return catalogModel(provider, model)?.contextWindow;
}

/** Catalog models the chat selector may offer. */
export function enabledModelOptions(settings: ChatSettings, provider: Provider = settings.provider): ModelOption[] {
  return (getCatalogModels(provider) ?? []).filter((option) =>
    // The selected model always stays available, even if an older data.json
    // marked it disabled before the settings UI protected the current row.
    option.value === settings.model || modelEnabled(settings, option.value));
}

/** A model preference object with invalid fields removed. */
export function normalizeModelPreferences(value: unknown): Record<string, ModelPreference> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const preferences: Record<string, ModelPreference> = {};
  for (const [model, raw] of Object.entries(value as Record<string, unknown>)) {
    if (!model || model === "__proto__" || model === "prototype" || model === "constructor") continue;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const record = raw as Record<string, unknown>;
    const preference: ModelPreference = {};
    if (typeof record.enabled === "boolean") preference.enabled = record.enabled;
    const contextWindow = validContextWindow(record.contextWindow);
    if (contextWindow !== undefined) preference.contextWindow = contextWindow;
    if (Object.keys(preference).length) preferences[model] = preference;
  }
  return preferences;
}
