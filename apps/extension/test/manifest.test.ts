import { describe, expect, it } from 'vitest';
import { buildManifest, EXTENSION_PAGES_CSP, FIREFOX_ADDON_ID } from '../scripts/manifest.js';

describe('manifest generator', () => {
  const chrome = buildManifest('chrome', '1.2.3');
  const firefox = buildManifest('firefox', '1.2.3');

  it('produces MV3 manifests with the given version for both targets', () => {
    for (const m of [chrome, firefox]) {
      expect(m.manifest_version).toBe(3);
      expect(m.version).toBe('1.2.3');
      expect(m.name).toBe('Techie Mind');
    }
  });

  it('uses a module service worker and side panel on Chrome', () => {
    expect(chrome.background).toEqual({ service_worker: 'background.js', type: 'module' });
    expect(chrome.side_panel).toEqual({ default_path: 'sidepanel/index.html' });
    expect(chrome.permissions).toContain('sidePanel');
    expect(chrome).not.toHaveProperty('browser_specific_settings');
  });

  it('uses background scripts, sidebar_action and a gecko id on Firefox', () => {
    expect(firefox.background).toEqual({ scripts: ['background.js'], type: 'module' });
    expect(firefox.sidebar_action).toMatchObject({ default_panel: 'sidepanel/index.html' });
    expect(firefox.browser_specific_settings).toMatchObject({ gecko: { id: FIREFOX_ADDON_ID } });
    expect(firefox.permissions).not.toContain('sidePanel');
    expect(firefox).not.toHaveProperty('side_panel');
  });

  it('forbids eval and remote scripts in extension pages', () => {
    for (const m of [chrome, firefox]) {
      const csp = (m.content_security_policy as { extension_pages: string }).extension_pages;
      expect(csp).toBe(EXTENSION_PAGES_CSP);
      expect(csp).not.toMatch(/unsafe-eval|unsafe-inline|https?:/);
    }
  });

  it('requests only least-privilege permissions', () => {
    // scripting: on-demand injection into the agent's tab only (Phase 1).
    const allowed = new Set([
      'storage',
      'tabs',
      'sidePanel',
      'scripting',
      'debugger',
      'bookmarks',
      'downloads',
      'tabGroups',
    ]);
    for (const m of [chrome, firefox]) {
      for (const p of m.permissions as string[]) expect(allowed.has(p), p).toBe(true);
    }
  });

  it('asks for debugger (trusted media clicks) on Chrome only', () => {
    expect(chrome.permissions as string[]).toContain('debugger');
    expect(firefox.permissions as string[]).not.toContain('debugger');
  });

  it('declares no content scripts (zero footprint in ordinary browsing) and one web host grant', () => {
    for (const m of [chrome, firefox]) {
      expect(m).not.toHaveProperty('content_scripts');
      // <all_urls> is what captureVisibleTab requires (Phase 4 visual fallback); nothing broader.
      expect(m.host_permissions).toEqual(['<all_urls>']);
      expect(m.permissions as string[]).not.toContain('activeTab');
    }
  });
});
