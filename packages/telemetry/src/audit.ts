import { AuditEvent } from '@techie-mind/contracts';
import type { LogSink } from './logger.js';

/**
 * Persistent, tamper-evident audit log (plan §47). Every record's hash covers its content and the
 * previous record's hash, so editing, reordering or deleting a record breaks the chain. The log is
 * a bounded ring: when old records are dropped, the hash of the last dropped record is kept as the
 * `anchor`, so truncation stays verifiable (the first kept record must point at the anchor).
 *
 * Records arrive already masked by the logger (privacy redaction + log masking). Storage is
 * abstracted so the extension uses chrome.storage.local and tests use memory.
 */

export const AUDIT_STORAGE_KEY = 'techieMind.audit';

export interface AuditStorage {
  get(): Promise<unknown>;
  set(value: StoredAudit): Promise<void>;
}

export interface StoredAudit {
  version: 1;
  anchor: string | null;
  events: AuditEvent[];
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Canonical JSON (object keys sorted, recursively): the hash must not depend on how a store
 * serializes objects — chrome.storage returns keys in alphabetical order.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}

function hashBody(event: AuditEvent, prevHash: string | null): string {
  return canonicalJson({ ...event, prevHash, hash: null });
}

export interface AuditVerification {
  ok: boolean;
  events: number;
  /** Index of the first record that fails, or -1. */
  brokenAt: number;
  reason: string | null;
}

export async function verifyAudit(stored: StoredAudit): Promise<AuditVerification> {
  let prev = stored.anchor;
  for (let i = 0; i < stored.events.length; i++) {
    const event = stored.events[i]!;
    if (event.prevHash !== prev) {
      return { ok: false, events: stored.events.length, brokenAt: i, reason: 'chain link broken' };
    }
    const expected = await sha256Hex(hashBody(event, event.prevHash));
    if (event.hash !== expected) {
      return { ok: false, events: stored.events.length, brokenAt: i, reason: 'record altered' };
    }
    prev = event.hash;
  }
  return { ok: true, events: stored.events.length, brokenAt: -1, reason: null };
}

function isStored(value: unknown): value is StoredAudit {
  if (!value || typeof value !== 'object') return false;
  const v = value as Partial<StoredAudit>;
  return (
    v.version === 1 &&
    Array.isArray(v.events) &&
    (v.anchor === null || typeof v.anchor === 'string')
  );
}

export class PersistentAuditLog implements LogSink {
  #state: StoredAudit | null = null;
  #tail: Promise<void> = Promise.resolve();
  #dirty = false;
  #timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly storage: AuditStorage,
    private readonly options: { maxEvents?: number; flushDelayMs?: number } = {},
  ) {}

  async #load(): Promise<StoredAudit> {
    if (this.#state) return this.#state;
    const raw = await this.storage.get();
    const valid = isStored(raw) ? raw.events.every((e) => AuditEvent.safeParse(e).success) : false;
    // An unreadable log is not silently "repaired": a fresh chain starts, anchored to nothing, and
    // the verification of the old one (if any) is the caller's to report.
    this.#state = valid ? (raw as StoredAudit) : { version: 1, anchor: null, events: [] };
    return this.#state;
  }

  write(event: AuditEvent): Promise<void> {
    this.#tail = this.#tail.then(async () => {
      const state = await this.#load();
      const prevHash = state.events.at(-1)?.hash ?? state.anchor;
      const hash = await sha256Hex(hashBody(event, prevHash));
      state.events.push({ ...event, prevHash, hash });
      const max = this.options.maxEvents ?? 2_000;
      if (state.events.length > max) {
        const dropped = state.events.splice(0, state.events.length - max);
        state.anchor = dropped.at(-1)?.hash ?? state.anchor;
      }
      this.#dirty = true;
      this.#schedule();
    });
    return this.#tail;
  }

  #schedule() {
    if (this.#timer) return;
    this.#timer = setTimeout(() => {
      this.#timer = null;
      void this.flush();
    }, this.options.flushDelayMs ?? 500);
  }

  /** Persist pending records (called at the end of every task, and periodically). */
  async flush(): Promise<void> {
    await this.#tail;
    if (this.#timer) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
    if (!this.#dirty || !this.#state) return;
    this.#dirty = false;
    await this.storage.set({
      version: 1,
      anchor: this.#state.anchor,
      events: [...this.#state.events],
    });
  }

  async read(): Promise<StoredAudit> {
    await this.flush();
    return this.#load();
  }
}
