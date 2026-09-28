import { AuditEvent, type AuditEventType, type LogLevel } from '@techie-mind/contracts';
import { maskData, maskString } from './mask.js';

export interface LogSink {
  write(event: AuditEvent): void | Promise<void>;
}

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface LoggerOptions {
  component: string;
  sinks: LogSink[];
  level?: LogLevel;
  now?: () => number;
  newId?: () => string;
  /**
   * Content redactor applied to every message and string field before masking (the extension
   * passes the privacy engine's `redactForLog`, so detected PII never reaches a sink).
   */
  redact?: (text: string) => string;
}

export interface EventOptions {
  level?: LogLevel;
  taskId?: string | null;
  data?: Record<string, unknown>;
}

export interface Logger {
  event(type: AuditEventType, message: string, options?: EventOptions): AuditEvent | null;
  child(component: string): Logger;
}

function defaultId(): string {
  return `evt-${crypto.randomUUID()}`;
}

/**
 * Structured logger. Every record is masked, then validated against the AuditEvent contract, so a
 * malformed or oversized record can never reach a sink.
 */
export function createLogger(options: LoggerOptions): Logger {
  const minLevel = LEVEL_ORDER[options.level ?? 'info'];
  const now = options.now ?? Date.now;
  const newId = options.newId ?? defaultId;
  const redact = options.redact ?? ((text: string) => text);
  const redactData = (data: ReturnType<typeof maskData>) =>
    Object.fromEntries(
      Object.entries(data).map(([k, v]) => [k, typeof v === 'string' ? redact(v) : v]),
    );

  const logger: Logger = {
    event(type, message, eventOptions = {}) {
      const level = eventOptions.level ?? 'info';
      if (LEVEL_ORDER[level] < minLevel) return null;
      const candidate = {
        eventId: newId(),
        type,
        level,
        at: now(),
        component: options.component,
        taskId: eventOptions.taskId ?? null,
        message: maskString(redact(message)).slice(0, 500),
        data: redactData(maskData(eventOptions.data ?? {})),
        prevHash: null,
        hash: null,
      };
      const parsed = AuditEvent.safeParse(candidate);
      if (!parsed.success) {
        console.error('[telemetry] dropped malformed log event', parsed.error.issues[0]?.message);
        return null;
      }
      for (const sink of options.sinks) void sink.write(parsed.data);
      return parsed.data;
    },
    child(component) {
      return createLogger({ ...options, component: `${options.component}/${component}` });
    },
  };
  return logger;
}

/** Bounded in-memory sink (activity timeline, diagnostics, tests). */
export class MemorySink implements LogSink {
  readonly #events: AuditEvent[] = [];
  constructor(private readonly capacity = 500) {}

  write(event: AuditEvent): void {
    this.#events.push(event);
    if (this.#events.length > this.capacity) this.#events.shift();
  }

  get events(): readonly AuditEvent[] {
    return this.#events;
  }
}

export class ConsoleSink implements LogSink {
  write(event: AuditEvent): void {
    const line = `[${event.component}] ${event.type} ${event.message}`;
    if (event.level === 'error') console.error(line, event.data);
    else console.warn(line, event.data);
  }
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Tamper-evident audit sink (spec §47): each record's hash covers its content plus the previous hash.
 * Writes are serialized so the chain order equals the event order.
 */
export class HashChainSink implements LogSink {
  readonly #chain: AuditEvent[] = [];
  #tail: Promise<void> = Promise.resolve();
  #lastHash: string | null = null;

  write(event: AuditEvent): Promise<void> {
    this.#tail = this.#tail.then(async () => {
      const prevHash = this.#lastHash;
      const body = JSON.stringify({ ...event, prevHash, hash: null });
      const hash = await sha256Hex(body);
      this.#lastHash = hash;
      this.#chain.push({ ...event, prevHash, hash });
    });
    return this.#tail;
  }

  async flush(): Promise<readonly AuditEvent[]> {
    await this.#tail;
    return this.#chain;
  }

  static async verify(chain: readonly AuditEvent[]): Promise<boolean> {
    let prev: string | null = null;
    for (const event of chain) {
      if (event.prevHash !== prev) return false;
      const expected = await sha256Hex(JSON.stringify({ ...event, hash: null }));
      if (event.hash !== expected) return false;
      prev = event.hash;
    }
    return true;
  }
}
