import type { BrowserAdapter, MessageSender } from '@techie-mind/browser';
import {
  BackgroundRequest,
  type ErrorResponse,
  type HealthResponse,
  type OkResponse,
} from '@techie-mind/contracts';
import type { Logger } from '@techie-mind/telemetry';

export type BackgroundResponse = HealthResponse | OkResponse | ErrorResponse;

function error(code: ErrorResponse['code'], message: string): ErrorResponse {
  return { type: 'ERROR', ok: false, code, message };
}

/**
 * Background request handler. Only this extension's own pages may call it, and every message must
 * match the BackgroundRequest contract — web pages and content scripts cannot reach it.
 */
export function createBackgroundHandler(deps: {
  adapter: BrowserAdapter;
  logger: Logger;
  startedAt: number;
  now?: () => number;
}) {
  const now = deps.now ?? Date.now;
  return async (message: unknown, sender: MessageSender): Promise<BackgroundResponse> => {
    if (!deps.adapter.isOwnExtensionPage(sender)) {
      deps.logger.event('ACTION_BLOCKED', 'rejected message from untrusted sender', {
        level: 'warn',
        data: { senderUrl: sender.url ?? null },
      });
      return error('UNTRUSTED_SENDER', 'sender is not a Techie Mind extension page');
    }
    const parsed = BackgroundRequest.safeParse(message);
    if (!parsed.success) {
      return error('INVALID_MESSAGE', 'message does not match the background contract');
    }
    switch (parsed.data.type) {
      case 'HEALTH_REQUEST':
        return {
          type: 'HEALTH_RESPONSE',
          ok: true,
          component: 'background',
          browser: deps.adapter.kind,
          version: deps.adapter.version,
          startedAt: deps.startedAt,
          uptimeMs: Math.max(0, now() - deps.startedAt),
        };
      case 'OPEN_SETTINGS':
        await deps.adapter.openSettings();
        return { type: 'OK', ok: true };
    }
  };
}
