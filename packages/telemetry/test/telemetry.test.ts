import { describe, expect, it } from 'vitest';
import {
  createLogger,
  HashChainSink,
  MASK,
  maskData,
  maskString,
  MemorySink,
  PersistentAuditLog,
  percentile,
  startSpan,
  verifyAudit,
  type StoredAudit,
} from '../src/index.js';

describe('masking', () => {
  it('masks values under sensitive keys regardless of content', () => {
    const out = maskData({ password: 'hunter2', apiKey: 'abc', otp: '123456', phone: 'x' });
    expect(out).toEqual({ password: MASK, apiKey: MASK, otp: MASK, phone: MASK });
  });

  it('masks sensitive patterns inside free text', () => {
    // Built at runtime so the repository never contains a key-shaped literal (secret scanning).
    const fakeKey = ['sk', 'abcdefghijklmnopqrstuv'].join('-');
    const text = `mail a.b@example.com call +91 9876543210 key ${fakeKey} pan ABCDE1234F card 4111 1111 1111 1111`;
    const masked = maskString(text);
    expect(masked).not.toMatch(/example\.com/);
    expect(masked).not.toMatch(/9876543210/);
    expect(masked).not.toContain(fakeKey);
    expect(masked).not.toMatch(/ABCDE1234F/);
    expect(masked).not.toMatch(/4111/);
  });

  it('keeps harmless text intact (positive control)', () => {
    expect(maskString('Search results rendered for running shoes')).toBe(
      'Search results rendered for running shoes',
    );
  });

  it('drops nested objects rather than serialising them', () => {
    expect(maskData({ page: { html: '<p>secret</p>' } })).toEqual({ page: '[OMITTED]' });
  });
});

describe('logger', () => {
  it('emits validated, masked events to sinks', () => {
    const sink = new MemorySink();
    const log = createLogger({
      component: 'test',
      sinks: [sink],
      now: () => 1,
      newId: () => 'e-1',
    });
    const event = log.event('ACTION_BLOCKED', 'blocked for user a@b.co', {
      level: 'warn',
      taskId: 'task-1',
      data: { token: 'abc', reason: 'stale' },
    });
    expect(event).not.toBeNull();
    expect(sink.events).toHaveLength(1);
    expect(sink.events[0]?.message).toBe(`blocked for user ${MASK}`);
    expect(sink.events[0]?.data).toEqual({ token: MASK, reason: 'stale' });
  });

  it('respects the minimum level', () => {
    const sink = new MemorySink();
    const log = createLogger({ component: 'test', sinks: [sink], level: 'warn' });
    expect(log.event('SYSTEM', 'debug noise', { level: 'debug' })).toBeNull();
    expect(sink.events).toHaveLength(0);
  });

  it('drops events that violate the AuditEvent contract', () => {
    const sink = new MemorySink();
    const log = createLogger({
      component: 'test',
      sinks: [sink],
      newId: () => 'bad id with spaces',
    });
    expect(log.event('SYSTEM', 'x')).toBeNull();
    expect(sink.events).toHaveLength(0);
  });

  it('bounds the memory sink', () => {
    const sink = new MemorySink(3);
    const log = createLogger({ component: 'test', sinks: [sink] });
    for (let i = 0; i < 5; i++) log.event('SYSTEM', `e${i}`);
    expect(sink.events.map((e) => e.message)).toEqual(['e2', 'e3', 'e4']);
  });
});

describe('hash-chained audit sink', () => {
  it('produces a verifiable chain and detects tampering', async () => {
    const chainSink = new HashChainSink();
    const log = createLogger({ component: 'audit', sinks: [chainSink] });
    log.event('TASK_STARTED', 'start', { taskId: 'task-1' });
    log.event('ACTION_EXECUTED', 'click', { taskId: 'task-1' });
    log.event('TASK_COMPLETED', 'done', { taskId: 'task-1' });
    const chain = await chainSink.flush();
    expect(chain).toHaveLength(3);
    expect(chain[0]?.prevHash).toBeNull();
    expect(chain[1]?.prevHash).toBe(chain[0]?.hash);
    expect(await HashChainSink.verify(chain)).toBe(true);

    const tampered = chain.map((e, i) => (i === 1 ? { ...e, message: 'changed' } : e));
    expect(await HashChainSink.verify(tampered)).toBe(false);
  });
});

describe('timing', () => {
  it('measures spans with an injectable clock and freezes on first end()', () => {
    let t = 100;
    const span = startSpan('intent', () => t);
    t = 142;
    expect(span.end()).toBe(42);
    t = 500;
    expect(span.end()).toBe(42);
  });

  it('computes nearest-rank percentiles', () => {
    const samples = [5, 1, 4, 2, 3, 6, 7, 8, 9, 10];
    expect(percentile(samples, 50)).toBe(5);
    expect(percentile(samples, 95)).toBe(10);
    expect(percentile([], 50)).toBeNull();
    expect(() => percentile(samples, 101)).toThrow(RangeError);
  });
});

describe('PersistentAuditLog — tamper-evident, persisted, bounded', () => {
  function memoryStorage() {
    let value: unknown = undefined;
    return {
      get: async () => value,
      set: async (v: StoredAudit) => {
        value = structuredClone(v);
      },
      peek: () => value as StoredAudit,
    };
  }
  const redactor = (t: string) => t.replace(/[\w.]+@[\w.]+\.\w+/g, '[REDACTED_EMAIL]');

  async function filled(n: number, maxEvents?: number) {
    const storage = memoryStorage();
    const log = new PersistentAuditLog(storage, {
      flushDelayMs: 1,
      ...(maxEvents ? { maxEvents } : {}),
    });
    const logger = createLogger({ component: 'agent', sinks: [log], redact: redactor });
    for (let i = 0; i < n; i++) {
      logger.event('ACTION_BLOCKED', `blocked action ${i} for asha.verma@example.com`, {
        taskId: 'task-1',
        data: { check: 'authorization', note: 'contact asha.verma@example.com' },
      });
    }
    await log.flush();
    return { storage, log };
  }

  it('persists a verifiable chain with no raw sensitive values', async () => {
    const { storage } = await filled(5);
    const stored = storage.peek();
    expect(stored.events).toHaveLength(5);
    expect(await verifyAudit(stored)).toMatchObject({ ok: true, events: 5 });
    expect(JSON.stringify(stored)).not.toContain('asha.verma@example.com');
    expect(stored.events[0]!.message).toContain('[REDACTED_EMAIL]');
    // A new log instance continues the same chain after a service-worker restart.
    const again = new PersistentAuditLog(storage, { flushDelayMs: 1 });
    await createLogger({ component: 'x', sinks: [again] }).event('SYSTEM', 'restart');
    await again.flush();
    expect(await verifyAudit(storage.peek())).toMatchObject({ ok: true, events: 6 });
  });

  it('detects an altered record, a deleted record and reordering', async () => {
    const { storage } = await filled(4);
    const altered = structuredClone(storage.peek());
    altered.events[1]!.message = 'nothing happened';
    expect(await verifyAudit(altered)).toMatchObject({
      ok: false,
      brokenAt: 1,
      reason: 'record altered',
    });
    const deleted = structuredClone(storage.peek());
    deleted.events.splice(2, 1);
    expect(await verifyAudit(deleted)).toMatchObject({ ok: false, brokenAt: 2 });
    const reordered = structuredClone(storage.peek());
    reordered.events.reverse();
    expect((await verifyAudit(reordered)).ok).toBe(false);
    const headCut = structuredClone(storage.peek());
    headCut.events.shift();
    expect((await verifyAudit(headCut)).ok).toBe(false);
  });

  it('stays bounded: old records roll off behind a verifiable anchor', async () => {
    const { storage } = await filled(12, 5);
    const stored = storage.peek();
    expect(stored.events).toHaveLength(5);
    expect(stored.anchor).toMatch(/^[0-9a-f]{64}$/);
    expect(await verifyAudit(stored)).toMatchObject({ ok: true });
  });
});

describe('audit hashing is independent of storage key order', () => {
  it('verifies after keys are re-ordered alphabetically (chrome.storage behaviour)', async () => {
    const log = new PersistentAuditLog(
      { get: async () => undefined, set: async () => undefined },
      { flushDelayMs: 1 },
    );
    await createLogger({ component: 'x', sinks: [log] }).event('SYSTEM', 'one', {
      data: { b: 1, a: 2 },
    });
    const stored = await log.read();
    const sortKeys = (o: unknown): unknown =>
      Array.isArray(o)
        ? o.map(sortKeys)
        : o && typeof o === 'object'
          ? Object.fromEntries(
              Object.keys(o)
                .sort()
                .map((k) => [k, sortKeys((o as Record<string, unknown>)[k])]),
            )
          : o;
    expect(await verifyAudit(sortKeys(stored) as StoredAudit)).toMatchObject({ ok: true });
  });
});
