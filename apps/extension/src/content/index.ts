import type { MessageSender } from '@techie-mind/browser';
import {
  ActivityOverlay,
  DomVersion,
  ElementRegistry,
  type PageContext,
} from '@techie-mind/perception';
import { createContentHandler, DEFER_MS } from './handler.js';

/**
 * Content script. Injected ON DEMAND by the background only into the tab the agent is working in
 * (chrome.scripting via the BrowserAdapter) — never into ordinary browsing. Injection is idempotent:
 * a second injection into the same document is a no-op, so the document identity stays stable.
 * Page text is treated strictly as data; nothing here evaluates page- or model-provided code.
 */
const FLAG = '__techieMindContent';
const scope = globalThis as unknown as Record<string, unknown>;

if (!scope[FLAG]) {
  scope[FLAG] = true;
  const ctx: PageContext = {
    doc: document,
    documentId: `doc-${crypto.randomUUID()}`,
    registry: new ElementRegistry(),
    version: new DomVersion(document.documentElement),
    overlay: new ActivityOverlay(document),
  };
  const handle = createContentHandler(chrome.runtime.id, ctx);

  chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
    let result;
    try {
      result = handle(message, sender as MessageSender);
    } catch (err) {
      sendResponse({
        type: 'ERROR',
        ok: false,
        code: 'INTERNAL',
        message: err instanceof Error ? err.message.slice(0, 500) : 'content handler failed',
      });
      return false;
    }
    sendResponse(result.response);
    const deferred = result.deferred;
    if (deferred) setTimeout(deferred, DEFER_MS);
    return false;
  });
}
