import type { ModelRequest } from '@techie-mind/contracts';
import type { RedactedImage } from '@techie-mind/privacy';
import { TransportError, type ModelTransport } from './transport.js';

/** Ollama keeps the model loaded between calls (spec §20: never initialise the model per action). */
export const OLLAMA_KEEP_ALIVE = '30m';

function trimSlash(url: string): string {
  return url.replace(/\/+$/, '');
}

function ok(status: number, what: string) {
  if (status < 200 || status >= 300)
    throw new TransportError('http', `${what} answered HTTP ${status}`);
}

/** Model names installed in Ollama (`/api/tags`). */
export async function ollamaModels(
  transport: ModelTransport,
  baseUrl: string,
  timeoutMs: number,
): Promise<string[]> {
  const reply = await transport.send({
    url: `${trimSlash(baseUrl)}/api/tags`,
    method: 'GET',
    request: null,
    timeoutMs,
  });
  ok(reply.status, 'Ollama');
  const models = (reply.json as { models?: Array<{ name?: unknown }> } | null)?.models;
  if (!Array.isArray(models)) throw new TransportError('malformed', 'Ollama sent no model list');
  return models.flatMap((m) => (typeof m?.name === 'string' ? [m.name] : []));
}

/** Exact model match; "qwen2.5vl" also matches "qwen2.5vl:latest". Never a different model. */
export function hasModel(installed: readonly string[], model: string): boolean {
  return installed.some((name) => name === model || name === `${model}:latest`);
}

export interface ChatCall {
  request: ModelRequest;
  model: string;
  system: string;
  user: string;
  schema?: unknown;
  /** Locally redacted screenshots (vision models), never URLs. */
  images?: RedactedImage[];
  timeoutMs: number;
}

export async function ollamaChat(
  transport: ModelTransport,
  baseUrl: string,
  call: ChatCall,
): Promise<string> {
  const reply = await transport.send({
    url: `${trimSlash(baseUrl)}/api/chat`,
    method: 'POST',
    request: call.request,
    wire: {
      model: call.model,
      stream: false,
      keep_alive: OLLAMA_KEEP_ALIVE,
      format: call.schema ?? 'json',
      options: { temperature: 0 },
      messages: [
        { role: 'system', content: call.system },
        {
          role: 'user',
          content: call.user,
          ...(call.images ? { images: call.images.map((_, i) => `<image:${i}>`) } : {}),
        },
      ],
    },
    ...(call.images ? { images: call.images } : {}),
    timeoutMs: call.timeoutMs,
  });
  ok(reply.status, 'Ollama');
  const content = (reply.json as { message?: { content?: unknown } } | null)?.message?.content;
  if (typeof content !== 'string') throw new TransportError('malformed', 'Ollama sent no message');
  return content;
}

/** OpenAI-compatible gateway (tier 4). The gateway holds any provider credential, never the browser. */
export async function gatewayChat(
  transport: ModelTransport,
  endpoint: string,
  call: ChatCall,
): Promise<string> {
  const reply = await transport.send({
    url: /\/v1$/.test(trimSlash(endpoint))
      ? `${trimSlash(endpoint)}/chat/completions`
      : `${trimSlash(endpoint)}/v1/chat/completions`,
    method: 'POST',
    request: call.request,
    wire: {
      model: call.model,
      temperature: 0,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: call.system },
        { role: 'user', content: call.user },
      ],
    },
    timeoutMs: call.timeoutMs,
  });
  ok(reply.status, 'the model gateway');
  const content = (reply.json as { choices?: Array<{ message?: { content?: unknown } }> } | null)
    ?.choices?.[0]?.message?.content;
  if (typeof content !== 'string')
    throw new TransportError('malformed', 'the gateway sent no message');
  return content;
}

/** Laya adapter: `/health` and `/v1/classify` (see scripts/laya/laya_adapter.py). */
export const LAYA_TOKEN_HEADER = 'x-techie-mind-laya-token';

export async function layaClassify(
  transport: ModelTransport,
  adapterUrl: string,
  token: string,
  request: ModelRequest,
  wire: unknown,
  timeoutMs: number,
): Promise<unknown> {
  const reply = await transport.send({
    url: `${trimSlash(adapterUrl)}/v1/classify`,
    method: 'POST',
    request,
    wire,
    ...(token ? { headers: { [LAYA_TOKEN_HEADER]: token } } : {}),
    timeoutMs,
  });
  if (reply.status === 401) throw new TransportError('http', 'Laya adapter rejected the token');
  ok(reply.status, 'Laya adapter');
  return reply.json;
}
