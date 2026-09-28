import { parseContract, type ParseResult } from '@techie-mind/contracts';
import { DEFAULT_SETTINGS, Settings, type ModelProvider } from './settings.js';

export * from './settings.js';

export const PRODUCT_NAME = 'Techie Mind';

/** chrome.storage.local key holding the validated Settings object. */
export const SETTINGS_STORAGE_KEY = 'techieMind.settings';

type PlainObject = Record<string, unknown>;

function isPlainObject(value: unknown): value is PlainObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function mergeDeep(base: PlainObject, patch: PlainObject): PlainObject {
  const out: PlainObject = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    const current = out[key];
    out[key] = isPlainObject(current) && isPlainObject(value) ? mergeDeep(current, value) : value;
  }
  return out;
}

/**
 * Validate stored settings. Missing sections are filled from defaults (forward-compatible storage),
 * but any present value that violates the schema makes the whole load fail — invalid settings are
 * never partially applied.
 */
export function parseSettings(stored: unknown): ParseResult<Settings> {
  if (stored === undefined || stored === null) return { ok: true, value: DEFAULT_SETTINGS };
  if (!isPlainObject(stored)) return { ok: false, issues: ['(root): settings must be an object'] };
  return parseContract(Settings, mergeDeep(DEFAULT_SETTINGS as unknown as PlainObject, stored));
}

/** Apply a partial update and validate the result. */
export function updateSettings(current: Settings, patch: unknown): ParseResult<Settings> {
  if (!isPlainObject(patch)) return { ok: false, issues: ['(root): patch must be an object'] };
  return parseContract(Settings, mergeDeep(current as unknown as PlainObject, patch));
}

export interface ActiveModel {
  provider: ModelProvider;
  /** Empty string when the selected provider has no model configured. */
  modelId: string;
  /** Label shown in the UI model chip. Derived from the same record the runtime uses. */
  label: string;
  /** Where requests for this model go; null when the provider is not configured. */
  endpoint: string | null;
  local: boolean;
  /** False when the selection cannot be used as configured. Callers must stop, not substitute. */
  configured: boolean;
}

/**
 * The single resolver every layer uses to learn which model is active (spec §54, master plan §22).
 * It never substitutes another model: an unusable selection is reported as `configured: false`.
 */
export function resolveActiveModel(settings: Settings): ActiveModel {
  const { activeProvider, ollama, openaiCompatible } = settings.model;
  if (activeProvider === 'ollama') {
    return {
      provider: 'ollama',
      modelId: ollama.model,
      label: ollama.model || 'No local model set',
      endpoint: ollama.baseUrl,
      local: true,
      configured: ollama.model.length > 0,
    };
  }
  return {
    provider: 'openai-compatible',
    modelId: openaiCompatible.model,
    label: openaiCompatible.model || 'No gateway model set',
    endpoint: openaiCompatible.endpoint,
    local: false,
    configured: openaiCompatible.endpoint !== null && openaiCompatible.model.length > 0,
  };
}
