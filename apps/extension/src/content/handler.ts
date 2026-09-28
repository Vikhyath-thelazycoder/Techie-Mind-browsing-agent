import type { MessageSender } from '@techie-mind/browser';
import { ContentRequest, type ContentResponse, type ErrorResponse } from '@techie-mind/contracts';
import {
  DEFER_MS,
  executeAction,
  observeDocument,
  probePage,
  type PageContext,
} from '@techie-mind/perception';
import { scanDocument } from '@techie-mind/privacy';
import { countInjectionText } from '@techie-mind/security';

export interface HandlerResult {
  response: ContentResponse;
  /** Navigation-capable side effect to run after the response is delivered. */
  deferred: (() => void) | null;
}

function error(code: ErrorResponse['code'], message: string): HandlerResult {
  return { response: { type: 'ERROR', ok: false, code, message }, deferred: null };
}

/**
 * Content-script request handler. Only this extension's background may call it (runtime messages
 * from a page, a tab, or another extension are rejected), and every message must satisfy the
 * ContentRequest contract — which re-validates any Action in full, binding included.
 */
export function createContentHandler(
  extensionId: string,
  ctx: PageContext,
  now: () => number = Date.now,
) {
  return (message: unknown, sender: MessageSender): HandlerResult => {
    if (sender.id !== extensionId || sender.tab !== undefined) {
      return error('UNTRUSTED_SENDER', 'untrusted sender');
    }
    const parsed = ContentRequest.safeParse(message);
    if (!parsed.success)
      return error('INVALID_MESSAGE', 'message does not match the content contract');
    const request = parsed.data;
    switch (request.type) {
      case 'CONTENT_PING':
        return {
          response: {
            type: 'CONTENT_PONG',
            ok: true,
            origin: ctx.doc.location.origin,
            documentId: ctx.documentId,
            readyState: ctx.doc.readyState,
          },
          deferred: null,
        };
      case 'OBSERVE':
        ctx.registry.prune();
        return {
          response: {
            type: 'OBSERVATION',
            observation: observeDocument(ctx.doc, {
              taskId: request.taskId,
              observationId: request.observationId,
              tabId: request.tabId,
              documentId: ctx.documentId,
              version: ctx.version.value,
              registry: ctx.registry,
              now: now(),
            }),
          },
          deferred: null,
        };
      case 'EXECUTE':
        return executeAction(request.action, ctx);
      case 'PROBE':
        return { response: probePage(ctx, request.elementId), deferred: null };
      case 'PRIVACY_SCAN': {
        const scan = scanDocument(ctx.doc);
        return {
          response: {
            type: 'PRIVACY_SCAN_RESULT',
            documentId: ctx.documentId,
            total: scan.total,
            byKind: scan.byKind as Record<string, number>,
            fields: scan.fields,
            injections: countInjectionText(scan.text),
            textChars: scan.textChars,
            truncated: scan.truncated,
            ms: scan.ms,
          },
          deferred: null,
        };
      }
    }
  };
}

export { DEFER_MS };
