import type { BrowserAdapter } from '@techie-mind/browser';
import {
  DEFAULT_SETTINGS,
  SETTINGS_STORAGE_KEY,
  parseSettings,
  updateSettings,
  type Settings,
} from '@techie-mind/config';
import { useEffect, useState } from 'preact/hooks';

export const SETTINGS_KEY = SETTINGS_STORAGE_KEY;

export interface SettingsState {
  settings: Settings;
  loaded: boolean;
  /** Set when stored settings failed validation: defaults are shown and the problem is surfaced. */
  loadError: string | null;
}

export async function loadSettings(adapter: BrowserAdapter): Promise<SettingsState> {
  const stored = await adapter.storageGet(SETTINGS_KEY);
  const parsed = parseSettings(stored);
  if (parsed.ok) return { settings: parsed.value, loaded: true, loadError: null };
  return {
    settings: DEFAULT_SETTINGS,
    loaded: true,
    loadError: `Stored settings are invalid and were not applied (${parsed.issues[0] ?? 'unknown'})`,
  };
}

export type SaveResult = { ok: true; settings: Settings } | { ok: false; issues: string[] };

/** Validate and persist a partial update. Nothing is written unless the full result is valid. */
export async function saveSettings(
  adapter: BrowserAdapter,
  current: Settings,
  patch: Record<string, unknown>,
): Promise<SaveResult> {
  const next = updateSettings(current, patch);
  if (!next.ok) return next;
  await adapter.storageSet(SETTINGS_KEY, next.value);
  return { ok: true, settings: next.value };
}

/** Live settings for a page: loads once and follows changes made by any other extension page. */
export function useSettings(adapter: BrowserAdapter): SettingsState {
  const [state, setState] = useState<SettingsState>({
    settings: DEFAULT_SETTINGS,
    loaded: false,
    loadError: null,
  });

  useEffect(() => {
    let active = true;
    void loadSettings(adapter).then((s) => active && setState(s));
    const unsubscribe = adapter.onStorageChange(SETTINGS_KEY, (value) => {
      const parsed = parseSettings(value);
      if (!active) return;
      setState(
        parsed.ok
          ? { settings: parsed.value, loaded: true, loadError: null }
          : {
              settings: DEFAULT_SETTINGS,
              loaded: true,
              loadError: 'Stored settings are invalid and were not applied',
            },
      );
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, [adapter]);

  return state;
}
