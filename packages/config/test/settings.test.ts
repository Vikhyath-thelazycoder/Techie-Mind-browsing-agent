import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SETTINGS,
  parseSettings,
  resolveActiveModel,
  Settings,
  updateSettings,
} from '../src/index.js';

describe('settings', () => {
  it('defaults are themselves valid', () => {
    expect(Settings.safeParse(DEFAULT_SETTINGS).success).toBe(true);
  });

  it('returns defaults when nothing is stored', () => {
    const result = parseSettings(undefined);
    expect(result.ok && result.value).toEqual(DEFAULT_SETTINGS);
  });

  it('fills missing sections from defaults', () => {
    const result = parseSettings({ schemaVersion: 1, research: { maxSitesPerQuery: 3 } });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.research.maxSitesPerQuery).toBe(3);
      expect(result.value.privacy.enabled).toBe(true);
    }
  });

  it('rejects non-loopback Ollama URLs (local models must stay local)', () => {
    const result = updateSettings(DEFAULT_SETTINGS, {
      model: { ollama: { baseUrl: 'http://192.168.1.20:11434' } },
    });
    expect(result.ok).toBe(false);
  });

  it('rejects plain-http remote model gateways', () => {
    const result = updateSettings(DEFAULT_SETTINGS, {
      model: { openaiCompatible: { endpoint: 'http://api.example.com/v1', model: 'x' } },
    });
    expect(result.ok).toBe(false);
  });

  it('cannot disable financial safety, human handover or Indian ID redaction', () => {
    expect(updateSettings(DEFAULT_SETTINGS, { agent: { financialSafety: false } }).ok).toBe(false);
    expect(updateSettings(DEFAULT_SETTINGS, { agent: { humanHandover: false } }).ok).toBe(false);
    expect(
      updateSettings(DEFAULT_SETTINGS, { privacy: { indianIdentityFinancialRedaction: false } }).ok,
    ).toBe(false);
  });

  it('does not accept API keys or unknown fields in settings', () => {
    expect(updateSettings(DEFAULT_SETTINGS, { model: { apiKey: 'sk-live-123' } }).ok).toBe(false);
    expect(updateSettings(DEFAULT_SETTINGS, { profile: { phone: '9999999999' } }).ok).toBe(false);
  });

  it('rejects export folders that try to escape the downloads folder', () => {
    expect(updateSettings(DEFAULT_SETTINGS, { export: { folder: '../../etc' } }).ok).toBe(false);
  });
});

describe('resolveActiveModel — one authority, no substitution', () => {
  it('reports exactly the configured local model', () => {
    const model = resolveActiveModel(DEFAULT_SETTINGS);
    expect(model).toEqual({
      provider: 'ollama',
      modelId: 'qwen2.5vl:7b',
      label: 'qwen2.5vl:7b',
      endpoint: 'http://127.0.0.1:11434',
      local: true,
      configured: true,
    });
  });

  it('switching provider changes model, label and endpoint together', () => {
    const updated = updateSettings(DEFAULT_SETTINGS, {
      model: {
        activeProvider: 'openai-compatible',
        openaiCompatible: { endpoint: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
      },
    });
    expect(updated.ok).toBe(true);
    if (updated.ok) {
      const model = resolveActiveModel(updated.value);
      expect(model.modelId).toBe('gpt-4o-mini');
      expect(model.label).toBe('gpt-4o-mini');
      expect(model.endpoint).toBe('https://api.openai.com/v1');
      expect(model.local).toBe(false);
      expect(model.configured).toBe(true);
    }
  });

  it('never pairs one provider with another provider’s model (regression)', () => {
    const configured = updateSettings(DEFAULT_SETTINGS, {
      model: {
        activeProvider: 'openai-compatible',
        openaiCompatible: { endpoint: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
      },
    });
    expect(configured.ok).toBe(true);
    if (!configured.ok) return;
    const backToLocal = updateSettings(configured.value, { model: { activeProvider: 'ollama' } });
    expect(backToLocal.ok).toBe(true);
    if (backToLocal.ok) {
      const model = resolveActiveModel(backToLocal.value);
      expect(model.provider).toBe('ollama');
      expect(model.modelId).toBe('qwen2.5vl:7b');
    }
  });

  it('reports an unconfigured gateway instead of falling back to another model', () => {
    const updated = updateSettings(DEFAULT_SETTINGS, {
      model: { activeProvider: 'openai-compatible' },
    });
    expect(updated.ok).toBe(true);
    if (updated.ok) {
      const model = resolveActiveModel(updated.value);
      expect(model.provider).toBe('openai-compatible');
      expect(model.modelId).toBe('');
      expect(model.endpoint).toBeNull();
      expect(model.configured).toBe(false);
    }
  });
});
