/**
 * Generates the per-browser manifest from one description, so Chrome and Firefox builds share
 * everything except the genuinely browser-specific keys (master plan §48–49).
 */

export type Target = 'chrome' | 'firefox';

export const PATHS = {
  background: 'background.js',
  content: 'content.js',
  sidePanel: 'sidepanel/index.html',
  settings: 'settings/index.html',
  icons: {
    16: 'icons/icon-16.png',
    32: 'icons/icon-32.png',
    48: 'icons/icon-48.png',
    128: 'icons/icon-128.png',
  },
} as const;

export const FIREFOX_ADDON_ID = 'techie-mind@sih26171.local';

/** Extension pages may only run bundled scripts: no remote code, no dynamic code evaluation (spec §96.17). */
export const EXTENSION_PAGES_CSP = "script-src 'self'; object-src 'self'; base-uri 'none'";

/**
 * Least privilege. `scripting` + http(s) host access let the background inject the content script
 * ON DEMAND into the one tab the agent is working in (Phase 1); nothing runs in ordinary browsing.
 */
const COMMON_PERMISSIONS = ['storage', 'tabs', 'scripting'] as const;
export const HOST_PERMISSIONS = ['http://*/*', 'https://*/*'] as const;

export function buildManifest(target: Target, version: string): Record<string, unknown> {
  const common = {
    manifest_version: 3,
    name: 'Techie Mind',
    short_name: 'Techie Mind',
    version,
    description: 'Privacy-first browser agent: local perception, local privacy, validated actions.',
    icons: PATHS.icons,
    action: {
      default_title: 'Open Techie Mind',
      default_icon: { 16: PATHS.icons[16], 32: PATHS.icons[32] },
    },
    host_permissions: [...HOST_PERMISSIONS],
    content_security_policy: { extension_pages: EXTENSION_PAGES_CSP },
  };

  if (target === 'chrome') {
    return {
      ...common,
      minimum_chrome_version: '116',
      permissions: [...COMMON_PERMISSIONS, 'sidePanel'],
      background: { service_worker: PATHS.background, type: 'module' },
      side_panel: { default_path: PATHS.sidePanel },
      options_page: PATHS.settings,
    };
  }

  return {
    ...common,
    permissions: [...COMMON_PERMISSIONS],
    background: { scripts: [PATHS.background], type: 'module' },
    sidebar_action: {
      default_title: 'Techie Mind',
      default_panel: PATHS.sidePanel,
      default_icon: { 16: PATHS.icons[16], 32: PATHS.icons[32] },
      open_at_install: false,
    },
    options_ui: { page: PATHS.settings, open_in_tab: true },
    browser_specific_settings: {
      gecko: {
        id: FIREFOX_ADDON_ID,
        strict_min_version: '142.0',
        data_collection_permissions: { required: ['none'] },
      },
    },
  };
}
