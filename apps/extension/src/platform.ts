import { createAdapter, type BrowserAdapter, type WebExtensionApi } from '@techie-mind/browser';

/**
 * The one place that binds shared code to the real browser. Both Chrome and Firefox MV3 expose the
 * promise-based `chrome` namespace; browser-specific behaviour lives in the adapter.
 */
export function getPlatform(): BrowserAdapter {
  return createAdapter(__TARGET__, chrome as unknown as WebExtensionApi);
}
