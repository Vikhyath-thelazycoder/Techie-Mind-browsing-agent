import type { ModelRequest } from '@techie-mind/contracts';
import type { RedactedImage } from '@techie-mind/privacy';

/**
 * How model clients reach a model endpoint. The extension implements it over `gatedFetch`
 * (purpose "model"): the ModelRequest is what the privacy gate validates, the wire body is the
 * provider format derived from it, and both are scanned before a byte leaves. Tests implement it
 * with stand-in servers.
 */
export interface ModelTransport {
  send(call: ModelCall): Promise<ModelReply>;
}

export interface ModelCall {
  url: string;
  method: 'GET' | 'POST';
  /** The validated request this call carries (null for bodiless health/model-list checks). */
  request: ModelRequest | null;
  /** Provider wire body derived from `request`. */
  wire?: unknown;
  headers?: Record<string, string>;
  /** Locally redacted screenshots, referenced from `wire` as "<image:N>". */
  images?: RedactedImage[];
  timeoutMs: number;
}

export interface ModelReply {
  status: number;
  json: unknown;
}

export type TransportFailure = 'blocked' | 'timeout' | 'unreachable' | 'http' | 'malformed';

export class TransportError extends Error {
  constructor(
    readonly kind: TransportFailure,
    message: string,
  ) {
    super(message);
  }
}
