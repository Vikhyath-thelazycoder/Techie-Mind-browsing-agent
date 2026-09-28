import { Action, elementFingerprint } from '@techie-mind/contracts';
import { computeName, computeRole } from '@techie-mind/perception';
import { describe, expect, it } from 'vitest';
import { makePage } from '../../../packages/perception/test/dom.js';
import { createContentHandler } from '../src/content/handler.js';

const BG = { id: 'ext-id' };

function setup() {
  const { ctx } = makePage(
    '<form action="/search"><input id="q" name="q" type="search" aria-label="Search"></form>',
  );
  return { ctx, handle: createContentHandler('ext-id', ctx, () => 1) };
}

describe('content handler (page side of the trust boundary)', () => {
  it('answers ping, observe and probe from its own background', () => {
    const { handle } = setup();
    expect(handle({ type: 'CONTENT_PING' }, BG).response).toMatchObject({
      type: 'CONTENT_PONG',
      documentId: 'doc-test',
    });
    const obs = handle({ type: 'OBSERVE', taskId: 't', observationId: 'o', tabId: 4 }, BG).response;
    expect(obs).toMatchObject({
      type: 'OBSERVATION',
      observation: { tabId: 4, taskId: 't', documentId: 'doc-test' },
    });
    expect(handle({ type: 'PROBE', elementId: null }, BG).response).toMatchObject({
      type: 'PROBE_RESULT',
    });
  });

  it('rejects senders that are a tab (page/other content script) or another extension', () => {
    const { handle } = setup();
    expect(
      handle({ type: 'CONTENT_PING' }, { id: 'ext-id', tab: { id: 1 } }).response,
    ).toMatchObject({ code: 'UNTRUSTED_SENDER' });
    expect(handle({ type: 'CONTENT_PING' }, { id: 'evil' }).response).toMatchObject({
      code: 'UNTRUSTED_SENDER',
    });
  });

  it('rejects anything outside the content contract, including raw scripts', () => {
    const { handle } = setup();
    expect(handle({ type: 'EVAL', code: 'document.cookie' }, BG).response).toMatchObject({
      code: 'INVALID_MESSAGE',
    });
    expect(handle({ type: 'OBSERVE', taskId: 't', observationId: 'o' }, BG).response).toMatchObject(
      { code: 'INVALID_MESSAGE' },
    );
  });

  it('re-validates EXECUTE actions against the full Action contract', () => {
    const { ctx, handle } = setup();
    const el = ctx.doc.getElementById('q')!;
    const valid = {
      actionId: 'a1',
      binding: {
        taskId: 't',
        observationId: 'o',
        documentId: 'doc-test',
        tabId: 1,
        origin: 'https://shop.example.test',
        target: {
          kind: 'element',
          elementId: ctx.registry.idFor(el),
          fingerprint: elementFingerprint(el.localName, computeRole(el), computeName(el)),
        },
        observationVersion: 0,
      },
      args: { type: 'TYPE', input: { text: 'boots' }, submit: false },
      reason: 'r',
      confidence: 1,
      expectedOutcome: { kind: 'field-value', description: '' },
      proposedBy: 'deterministic',
      createdAt: 0,
    };
    expect(Action.safeParse(valid).success).toBe(true);
    expect(handle({ type: 'EXECUTE', action: valid }, BG).response).toMatchObject({
      status: 'executed',
      valueAfter: 'boots',
    });
    // Unbound (targetless) TYPE, non-web navigation and smuggled fields are rejected before execution.
    const unbound = { ...valid, binding: { ...valid.binding, target: null } };
    expect(handle({ type: 'EXECUTE', action: unbound }, BG).response).toMatchObject({
      code: 'INVALID_MESSAGE',
    });
    const jsNav = {
      ...valid,
      binding: { ...valid.binding, target: null },
      // eslint-disable-next-line no-script-url -- hostile input under test: must be rejected
      args: { type: 'NAVIGATE', url: 'javascript:alert(1)' },
    };
    expect(handle({ type: 'EXECUTE', action: jsNav }, BG).response).toMatchObject({
      code: 'INVALID_MESSAGE',
    });
    expect(
      handle({ type: 'EXECUTE', action: { ...valid, script: 'x' } }, BG).response,
    ).toMatchObject({ code: 'INVALID_MESSAGE' });
  });
});
