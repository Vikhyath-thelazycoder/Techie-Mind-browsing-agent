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
// bookmarks + downloads: the manage-bookmarks, save-page, extract-data and walkthrough skills (Phase 6).
const COMMON_PERMISSIONS = ['storage', 'tabs', 'scripting', 'bookmarks', 'downloads'] as const;
/**
 * `<all_urls>` rather than http/https patterns: Chrome and Firefox allow `tabs.captureVisibleTab`
 * (the Phase 4 visual fallback) only with it. The agent still scripts http(s) pages only — every
 * injection and navigation path checks `isWebUrl` — and file:// stays behind the browser's own
 * per-extension toggle, which Techie Mind never asks for.
 */
export const HOST_PERMISSIONS = ['<all_urls>'] as const;

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
      // debugger: trusted clicks for media (Phase 5, setting "trustedMediaClicks"); attached only for
      // the click itself, Chrome shows its "debugging this browser" bar while attached.
      // tabGroups: the organize-tabs skill groups tabs by site (Chrome only).
      permissions: [...COMMON_PERMISSIONS, 'sidePanel', 'debugger', 'tabGroups'],
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
