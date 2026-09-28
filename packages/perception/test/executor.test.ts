import { Action, elementFingerprint, type ActionArgs } from '@techie-mind/contracts';
import { describe, expect, it, vi } from 'vitest';
import {
  computeName,
  computeRole,
  executeAction,
  observeDocument,
  probePage,
  type PageContext,
} from '../src/index.js';
import { makePage } from './dom.js';

const PAGE = `
<form action="/search"><input id="q" name="q" type="search" placeholder="Search"><button id="go">Search</button></form>
<input id="off" disabled aria-label="Disabled">
<a id="link" href="/next">Next page link</a>
<p id="para">plain</p>`;

function setup(html = PAGE) {
  const { dom, ctx } = makePage(html);
  observeDocument(ctx.doc, {
    taskId: 't',
    observationId: 'o',
    tabId: 1,
    documentId: ctx.documentId,
    version: 0,
    registry: ctx.registry,
    now: 0,
  });
  return { dom, ctx };
}

function actionFor(
  ctx: PageContext,
  selector: string | null,
  args: ActionArgs,
  overrides: Partial<Action['binding']> = {},
): Action {
  const el = selector ? ctx.doc.querySelector(selector)! : null;
  return Action.parse({
    actionId: 'act-1',
    binding: {
      taskId: 't',
      observationId: 'o',
      documentId: ctx.documentId,
      tabId: 1,
      origin: ctx.doc.location.origin,
      target: el
        ? {
            kind: 'element',
            elementId: ctx.registry.idFor(el),
            fingerprint: elementFingerprint(el.localName, computeRole(el), computeName(el)),
          }
        : null,
      observationVersion: 0,
      ...overrides,
    },
    args,
    reason: 'test',
    confidence: 1,
    expectedOutcome: { kind: 'none', description: '' },
    proposedBy: 'deterministic',
    createdAt: 0,
  });
}

const TYPE: ActionArgs = { type: 'TYPE', input: { text: 'trail shoes' }, submit: false };

describe('executor binding checks', () => {
  it('rejects an action planned for another document', () => {
    const { ctx } = setup();
    const r = executeAction(actionFor(ctx, '#q', TYPE, { documentId: 'doc-other' }), ctx).response;
    expect(r).toMatchObject({ status: 'rejected', code: 'DOCUMENT_MISMATCH' });
  });

  it('rejects an action whose origin differs from the page', () => {
    const { ctx } = setup();
    const r = executeAction(
      actionFor(ctx, '#q', TYPE, { origin: 'https://evil.example' }),
      ctx,
    ).response;
    expect(r).toMatchObject({ status: 'rejected', code: 'ORIGIN_MISMATCH' });
  });

  it('rejects an observation version from the future', () => {
    const { ctx } = setup();
    const r = executeAction(actionFor(ctx, '#q', TYPE, { observationVersion: 99 }), ctx).response;
    expect(r.code).toBe('STALE_OBSERVATION');
  });

  it('rejects when the target element id is unknown', () => {
    const { ctx } = setup();
    const a = actionFor(ctx, '#q', TYPE);
    const r = executeAction(
      {
        ...a,
        binding: {
          ...a.binding,
          target: { kind: 'element', elementId: 'el-9999', fingerprint: null },
        },
      },
      ctx,
    ).response;
    expect(r.code).toBe('TARGET_MISSING');
  });

  it('rejects when the target was removed from the page', () => {
    const { ctx } = setup();
    const a = actionFor(ctx, '#q', TYPE);
    ctx.doc.getElementById('q')!.remove();
    expect(executeAction(a, ctx).response.code).toBe('TARGET_DETACHED');
  });

  it('rejects when the element behind the id is no longer the same element', () => {
    const { ctx } = setup();
    const a = actionFor(ctx, '#q', TYPE);
    ctx.doc.getElementById('q')!.setAttribute('aria-label', 'Email address');
    expect(executeAction(a, ctx).response.code).toBe('TARGET_CHANGED');
  });

  it('rejects disabled, non-editable and hidden targets', () => {
    const { ctx } = setup();
    expect(executeAction(actionFor(ctx, '#off', TYPE), ctx).response.code).toBe('TARGET_DISABLED');
    expect(executeAction(actionFor(ctx, '#link', TYPE), ctx).response.code).toBe(
      'TARGET_NOT_EDITABLE',
    );
    const a = actionFor(ctx, '#q', TYPE);
    ctx.doc.getElementById('q')!.setAttribute('data-zero-size', '');
    expect(executeAction(a, ctx).response.code).toBe('TARGET_HIDDEN');
  });

  it('refuses actions that are not page primitives (NAVIGATE belongs to the browser layer)', () => {
    const { ctx } = setup();
    const r = executeAction(
      actionFor(ctx, null, { type: 'NAVIGATE', url: 'https://evil.example/' }),
      ctx,
    ).response;
    expect(r.code).toBe('UNSUPPORTED_ACTION');
  });

  it('refuses vault-token input until the Phase 2 vault exists', () => {
    const { ctx } = setup();
    const r = executeAction(
      actionFor(ctx, '#q', { type: 'TYPE', input: { vaultToken: 'PHONE_001' }, submit: false }),
      ctx,
    ).response;
    expect(r.code).toBe('UNSUPPORTED_ACTION');
  });
});

describe('executor primitives', () => {
  it('TYPE sets the value through the native setter and fires input/change', () => {
    const { ctx } = setup();
    const input = ctx.doc.getElementById('q') as HTMLInputElement;
    const events: string[] = [];
    input.addEventListener('input', () => events.push('input'));
    input.addEventListener('change', () => events.push('change'));
    const { response, deferred } = executeAction(actionFor(ctx, '#q', TYPE), ctx);
    expect(response).toMatchObject({
      status: 'executed',
      valueAfter: 'trail shoes',
      deferred: false,
    });
    expect(input.value).toBe('trail shoes');
    expect(events).toEqual(['input', 'change']);
    expect(deferred).toBeNull();
  });

  it('TYPE+submit performs implicit form submission after the response', () => {
    const { ctx } = setup();
    const form = ctx.doc.querySelector('form')!;
    const submitted = vi.fn((e: Event) => e.preventDefault());
    form.addEventListener('submit', submitted);
    const { response, deferred } = executeAction(
      actionFor(ctx, '#q', { ...TYPE, submit: true } as ActionArgs),
      ctx,
    );
    expect(response.deferred).toBe(true);
    expect(submitted).not.toHaveBeenCalled();
    deferred?.();
    expect(submitted).toHaveBeenCalledOnce();
  });

  it('does not submit when the page cancels the Enter key (page handles it itself)', () => {
    const { ctx } = setup();
    const input = ctx.doc.getElementById('q')!;
    input.addEventListener('keydown', (e) => e.preventDefault());
    const form = ctx.doc.querySelector('form')!;
    const submitted = vi.fn((e: Event) => e.preventDefault());
    form.addEventListener('submit', submitted);
    executeAction(actionFor(ctx, '#q', { ...TYPE, submit: true } as ActionArgs), ctx).deferred?.();
    expect(submitted).not.toHaveBeenCalled();
  });

  it('CLICK is deferred and dispatches a real click on the bound element', () => {
    const { ctx } = setup();
    const clicked = vi.fn((e: Event) => e.preventDefault());
    ctx.doc.getElementById('link')!.addEventListener('click', clicked);
    const { response, deferred } = executeAction(actionFor(ctx, '#link', { type: 'CLICK' }), ctx);
    expect(response).toMatchObject({ status: 'executed', deferred: true });
    deferred?.();
    expect(clicked).toHaveBeenCalledOnce();
  });

  it('probe reports URL, document, element value and media state', () => {
    const { ctx } = setup();
    (ctx.doc.getElementById('q') as HTMLInputElement).value = 'abc';
    const p = probePage(ctx, ctx.registry.idFor(ctx.doc.getElementById('q')!));
    expect(p).toMatchObject({
      url: 'https://shop.example.test/',
      documentId: 'doc-test',
      element: { exists: true, value: 'abc' },
      media: { present: false, playing: false },
    });
  });
});
