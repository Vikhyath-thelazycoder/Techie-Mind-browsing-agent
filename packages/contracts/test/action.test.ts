import { describe, expect, it } from 'vitest';
import { Action, ActionProposal, parseContract } from '../src/index.js';
import { action, binding } from './fixtures.js';

describe('Action contract', () => {
  it('accepts a fully bound, well-formed action', () => {
    expect(parseContract(Action, action()).ok).toBe(true);
  });

  it.each([
    'taskId',
    'observationId',
    'documentId',
    'tabId',
    'origin',
    'target',
    'observationVersion',
  ])('rejects an action whose binding is missing %s', (field) => {
    const b: Record<string, unknown> = { ...binding() };
    delete b[field];
    expect(parseContract(Action, { ...action(), binding: b }).ok).toBe(false);
  });

  it('rejects a targeted action (CLICK) with a null target', () => {
    const result = parseContract(Action, {
      ...action({ args: { type: 'CLICK' } }),
      binding: binding({ target: null }),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues.join()).toMatch(/CLICK requires a bound target/);
  });

  it('allows an untargeted action (NAVIGATE) with a null target', () => {
    const result = parseContract(Action, {
      ...action({ args: { type: 'NAVIGATE', url: 'https://www.flipkart.com/' } }),
      binding: binding({ target: null }),
    });
    expect(result.ok).toBe(true);
  });

  it.each([
    // eslint-disable-next-line no-script-url -- hostile input under test: must be rejected
    'javascript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'file:///etc/passwd',
    'chrome://settings',
    '/relative/path',
  ])('rejects NAVIGATE to non-web URL %s', (url) => {
    expect(parseContract(Action, action({ args: { type: 'NAVIGATE', url } as never })).ok).toBe(
      false,
    );
  });

  it('rejects unknown action types such as script execution', () => {
    const evil = { ...action(), args: { type: 'EXECUTE_SCRIPT', code: 'document.cookie' } };
    expect(parseContract(Action, evil).ok).toBe(false);
  });

  it('rejects extra keys smuggled into action args', () => {
    const smuggled = { ...action(), args: { type: 'CLICK', script: 'alert(1)' } };
    expect(parseContract(Action, smuggled).ok).toBe(false);
  });

  it('rejects keys outside the allowlist for PRESS_KEY', () => {
    expect(
      parseContract(Action, action({ args: { type: 'PRESS_KEY', key: 'F12' } as never })).ok,
    ).toBe(false);
    expect(parseContract(Action, action({ args: { type: 'PRESS_KEY', key: 'Enter' } })).ok).toBe(
      true,
    );
  });

  it('accepts TYPE with a vault token and rejects TYPE carrying both text and a token', () => {
    const withToken = action({
      args: { type: 'TYPE', input: { vaultToken: 'PHONE_001' }, submit: false },
    });
    expect(parseContract(Action, withToken).ok).toBe(true);

    const both = action({
      args: {
        type: 'TYPE',
        input: { text: '9999999999', vaultToken: 'PHONE_001' } as never,
        submit: false,
      },
    });
    expect(parseContract(Action, both).ok).toBe(false);
  });

  it('rejects a non-origin value in the binding origin', () => {
    const bad = { ...action(), binding: binding({ origin: 'https://www.youtube.com/watch?v=1' }) };
    expect(parseContract(Action, bad).ok).toBe(false);
  });

  it('rejects confidence outside [0,1] and negative tab ids', () => {
    expect(parseContract(Action, action({ confidence: 1.5 })).ok).toBe(false);
    expect(parseContract(Action, { ...action(), binding: binding({ tabId: -1 }) }).ok).toBe(false);
  });
});

describe('ActionProposal contract (model output)', () => {
  const proposal = {
    observationId: 'obs-1',
    targetElementId: 'el-12',
    args: { type: 'CLICK' },
    reason: 'Submit search',
    confidence: 0.8,
    expectedOutcome: { kind: 'result-set-changed', description: 'results change' },
  };

  it('accepts a structured proposal', () => {
    expect(parseContract(ActionProposal, proposal).ok).toBe(true);
  });

  it('rejects a proposal that tries to carry its own binding or tab control', () => {
    expect(parseContract(ActionProposal, { ...proposal, tabId: 3 }).ok).toBe(false);
    expect(parseContract(ActionProposal, { ...proposal, binding: binding() }).ok).toBe(false);
  });

  it('rejects free-form text instead of structured output', () => {
    expect(parseContract(ActionProposal, 'click the search button').ok).toBe(false);
  });
});
