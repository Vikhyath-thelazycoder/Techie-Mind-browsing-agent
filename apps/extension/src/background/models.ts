import { resolveActiveModel, type Settings } from '@techie-mind/config';
import {
  createIntelligence,
  TransportError,
  type Intelligence,
  type ModelCall,
  type ModelTransport,
} from '@techie-mind/models';
import { gatedFetch, OutboundPrivacyGate, PrivacyGateError } from '@techie-mind/privacy';

/** Answers from a model endpoint are small JSON; anything larger is refused. */
const MAX_REPLY_BYTES = 256 * 1024;

/**
 * Model transport over the outbound privacy gate (purpose "model"): the ModelRequest is validated,
 * the provider wire body is scanned with it, and only loopback endpoints — or the one configured
 * gateway host — are reachable. No cookies, no referrer, bounded time and size.
 */
export function gatedModelTransport(settings: Settings): ModelTransport {
  const active = resolveActiveModel(settings);
  let gatewayHost: string | null = null;
  if (!active.local && active.endpoint) {
    try {
      gatewayHost = new URL(active.endpoint).hostname;
    } catch {
      gatewayHost = null;
    }
  }
  const gate = new OutboundPrivacyGate({
    allow: { model: (host) => gatewayHost !== null && host === gatewayHost },
  });
  return {
    async send(call: ModelCall) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), call.timeoutMs);
      try {
        const response = await gatedFetch(
          gate,
          {
            purpose: 'model',
            url: call.url,
            method: call.method,
            payload: call.request,
            ...(call.wire !== undefined ? { wire: call.wire } : {}),
            ...(call.headers ? { headers: call.headers } : {}),
            ...(call.images ? { images: call.images } : {}),
          },
          { signal: controller.signal },
        );
        const text = await response.text();
        if (text.length > MAX_REPLY_BYTES) {
          throw new TransportError('malformed', 'model answer too large');
        }
        let json: unknown = null;
        try {
          json = text ? JSON.parse(text) : null;
        } catch {
          throw new TransportError('malformed', 'model endpoint did not answer JSON');
        }
        return { status: response.status, json };
      } catch (error) {
        if (error instanceof TransportError) throw error;
        if (error instanceof PrivacyGateError) {
          throw new TransportError('blocked', `privacy gate (${error.decision.check})`);
        }
        if (controller.signal.aborted) {
          throw new TransportError('timeout', `no answer within ${call.timeoutMs} ms`);
        }
        throw new TransportError(
          'unreachable',
          `${new URL(call.url).host} is not reachable — is it running?`,
        );
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

/** The model tiers for one task, from the settings in force when it starts. */
export function intelligenceFor(settings: Settings): Intelligence {
  return createIntelligence({ settings, transport: gatedModelTransport(settings) });
}
