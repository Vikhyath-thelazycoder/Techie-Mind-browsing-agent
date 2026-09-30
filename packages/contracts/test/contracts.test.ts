import { describe, expect, it } from 'vitest';
import {
  AuditEvent,
  boundedWebUrl,
  CONTRACTS,
  canTransition,
  HandoverState,
  IntentProfile,
  ModelRequest,
  Monitor,
  Observation,
  parseContract,
  PrivacyFinding,
  RecoveryDecision,
  SanitizedObservation,
  Skill,
  Target,
  Task,
  toJsonSchemas,
} from '../src/index.js';
import { NOW, observation, sanitizedObservation, task } from './fixtures.js';

describe('contract registry', () => {
  it('registers every contract listed in master plan §9', () => {
    const required = [
      'Task',
      'Intent',
      'IntentProfile',
      'Target',
      'Observation',
      'DOMNode',
      'AccessibilityNode',
      'VisualRegion',
      'PrivacyFinding',
      'SanitizedObservation',
      'ModelRequest',
      'ModelDecision',
      'Action',
      'ActionResult',
      'VerificationResult',
      'RecoveryDecision',
      'HandoverState',
      'Skill',
      'Monitor',
      'MonitorResult',
      'Notification',
      'AuditEvent',
    ];
    expect(Object.keys(CONTRACTS)).toEqual(expect.arrayContaining(required));
  });

  it('exports a JSON Schema object for every contract', () => {
    const schemas = toJsonSchemas();
    for (const name of Object.keys(CONTRACTS)) {
      const schema = schemas[name as keyof typeof schemas] as Record<string, unknown>;
      expect(schema, name).toBeTypeOf('object');
      expect(schema.$schema, name).toMatch(/json-schema/);
    }
  });
});

describe('Task', () => {
  it('accepts a valid task and rejects blank text or unbounded steps', () => {
    expect(parseContract(Task, task()).ok).toBe(true);
    expect(parseContract(Task, task({ text: '   ' })).ok).toBe(false);
    expect(parseContract(Task, task({ maxSteps: 10_000 })).ok).toBe(false);
  });
});

describe('IntentProfile', () => {
  const profile = {
    intent: 'media_playback',
    targetDomain: 'youtube.com',
    directNavigation: true,
    action: 'search_and_play',
    query: 'Kannada songs',
    constraints: [],
    entities: [],
    language: 'en',
    riskLevel: 'LOW',
    requiresConfirmation: false,
    confidence: 0.95,
    resolvedBy: 'deterministic',
    targetSource: 'EXPLICIT_USER_TARGET',
    navigationPolicy: 'DIRECT_NAVIGATE',
    siteName: null,
    ordinal: null,
  };

  it('accepts the spec §8 example', () => {
    expect(parseContract(IntentProfile, profile).ok).toBe(true);
  });

  it('requires a navigation policy and rejects unknown policies or target sources', () => {
    const withoutPolicy: Record<string, unknown> = { ...profile };
    delete withoutPolicy['navigationPolicy'];
    expect(parseContract(IntentProfile, withoutPolicy).ok).toBe(false);
    expect(parseContract(IntentProfile, { ...profile, navigationPolicy: 'GOOGLE_IT' }).ok).toBe(
      false,
    );
    expect(parseContract(IntentProfile, { ...profile, targetSource: 'ANYWHERE' }).ok).toBe(false);
    expect(parseContract(IntentProfile, { ...profile, ordinal: 0 }).ok).toBe(false);
  });

  it('rejects a target domain that is a URL rather than a hostname', () => {
    expect(
      parseContract(IntentProfile, { ...profile, targetDomain: 'https://youtube.com' }).ok,
    ).toBe(false);
  });
});

describe('Observation vs SanitizedObservation', () => {
  it('accepts valid observations', () => {
    expect(parseContract(Observation, observation()).ok).toBe(true);
    expect(parseContract(SanitizedObservation, sanitizedObservation()).ok).toBe(true);
  });

  it('rejects a sanitized observation that is not marked sanitized', () => {
    expect(
      parseContract(SanitizedObservation, { ...sanitizedObservation(), sanitized: false }).ok,
    ).toBe(false);
  });

  it('refuses to accept a raw observation where a sanitized one is required', () => {
    expect(parseContract(SanitizedObservation, observation()).ok).toBe(false);
  });
});

describe('PrivacyFinding', () => {
  const finding = {
    findingId: 'f-1',
    category: 'IDENTITY',
    kind: 'aadhaar',
    layer: 'checksum',
    location: { kind: 'dom', nodeId: 'el-3' },
    confidence: 0.99,
    treatment: 'tokenize',
    token: 'AADHAAR_001',
  };

  it('accepts a finding that references a vault token', () => {
    expect(parseContract(PrivacyFinding, finding).ok).toBe(true);
  });

  it('cannot carry the raw sensitive value (extra keys are rejected)', () => {
    expect(parseContract(PrivacyFinding, { ...finding, value: '1234 5678 9012' }).ok).toBe(false);
    expect(parseContract(PrivacyFinding, { ...finding, raw: '1234 5678 9012' }).ok).toBe(false);
  });
});

describe('ModelRequest', () => {
  const request = {
    requestId: 'req-1',
    taskId: 'task-1',
    tier: 'qwen',
    modelId: 'qwen2.5:7b',
    purpose: 'plan-action',
    userGoal: 'Find running shoes under 5000 rupees',
    intent: null,
    observation: sanitizedObservation(),
    createdAt: NOW,
    sanitized: true,
  };

  it('accepts a request carrying a sanitized observation', () => {
    expect(parseContract(ModelRequest, request).ok).toBe(true);
  });

  it('rejects a request carrying a raw observation', () => {
    expect(parseContract(ModelRequest, { ...request, observation: observation() }).ok).toBe(false);
  });

  it('rejects a request not marked sanitized', () => {
    expect(parseContract(ModelRequest, { ...request, sanitized: false }).ok).toBe(false);
  });
});

describe('RecoveryDecision', () => {
  it('ties level 6 to human handover', () => {
    const base = { actionId: 'a', attempt: 1, reason: 'target missing' };
    expect(parseContract(RecoveryDecision, { ...base, level: 1, strategy: 'retry' }).ok).toBe(true);
    expect(parseContract(RecoveryDecision, { ...base, level: 6, strategy: 'handover' }).ok).toBe(
      true,
    );
    expect(parseContract(RecoveryDecision, { ...base, level: 6, strategy: 'retry' }).ok).toBe(
      false,
    );
    expect(parseContract(RecoveryDecision, { ...base, level: 2, strategy: 'handover' }).ok).toBe(
      false,
    );
    expect(parseContract(RecoveryDecision, { ...base, level: 7, strategy: 'handover' }).ok).toBe(
      false,
    );
  });
});

describe('Handover state machine', () => {
  it('follows RUNNING → HUMAN_REQUIRED → PAUSED → USER_COMPLETED → RESUME → RUNNING', () => {
    expect(canTransition('RUNNING', 'HUMAN_REQUIRED')).toBe(true);
    expect(canTransition('HUMAN_REQUIRED', 'PAUSED')).toBe(true);
    expect(canTransition('PAUSED', 'USER_COMPLETED')).toBe(true);
    expect(canTransition('USER_COMPLETED', 'RESUME')).toBe(true);
    expect(canTransition('RESUME', 'RUNNING')).toBe(true);
  });

  it('forbids skipping the human step', () => {
    expect(canTransition('HUMAN_REQUIRED', 'RUNNING')).toBe(false);
    expect(canTransition('HUMAN_REQUIRED', 'RESUME')).toBe(false);
  });

  it('validates handover records', () => {
    const state = {
      taskId: 'task-1',
      phase: 'HUMAN_REQUIRED',
      reason: 'captcha',
      userInstruction: 'Solve the CAPTCHA on the page, then press Resume.',
      resumeCondition: 'After you press Resume.',
      since: NOW,
    };
    expect(parseContract(HandoverState, state).ok).toBe(true);
    expect(parseContract(HandoverState, { ...state, phase: 'GUESS_OTP' }).ok).toBe(false);
  });
});

describe('Monitor', () => {
  const monitor = {
    monitorId: 'm-1',
    ownerId: 'u-1',
    url: 'https://www.flipkart.com/some-laptop/p/itm123',
    condition: { kind: 'price-below', threshold: 60000, currency: 'INR' },
    intervalMinutes: 60,
    status: 'active',
    recipientId: 'r-1',
    createdAt: NOW,
    lastCheckedAt: null,
  };

  it('accepts an https monitor', () => {
    expect(parseContract(Monitor, monitor).ok).toBe(true);
  });

  it('rejects plain-http targets, sub-5-minute intervals and raw email recipients', () => {
    expect(parseContract(Monitor, { ...monitor, url: 'http://example.com/' }).ok).toBe(false);
    expect(parseContract(Monitor, { ...monitor, intervalMinutes: 1 }).ok).toBe(false);
    expect(parseContract(Monitor, { ...monitor, email: 'someone@example.com' }).ok).toBe(false);
  });
});

describe('Skill', () => {
  it('accepts one of the 12 skills and rejects unknown ones', () => {
    const skill = {
      id: 'summarize-page',
      name: 'Summarize Page',
      description: 'Summarize the current page locally first.',
      version: '1.0.0',
      inputs: [],
      riskLevel: 'LOW',
      requiresConfirmation: false,
      permissions: ['tabs'],
      verification: 'summary produced from sanitized page text',
      failureHandling: 'report extraction failure',
    };
    expect(parseContract(Skill, skill).ok).toBe(true);
    expect(parseContract(Skill, { ...skill, id: 'hack-bank' }).ok).toBe(false);
  });
});

describe('AuditEvent', () => {
  it('only accepts flat primitive data (no nested page content)', () => {
    const event = {
      eventId: 'e-1',
      type: 'ACTION_BLOCKED',
      level: 'warn',
      at: NOW,
      component: 'firewall',
      taskId: 'task-1',
      message: 'stale observation',
      data: { observationVersion: 3, liveVersion: 4 },
      prevHash: null,
      hash: null,
    };
    expect(parseContract(AuditEvent, event).ok).toBe(true);
    expect(
      parseContract(AuditEvent, { ...event, data: { page: { html: '<div>…</div>' } } }).ok,
    ).toBe(false);
  });
});

// Live on the Mac: Amazon's sign-in URL (long openid.return_to query) broke the observation.
describe('boundedWebUrl', () => {
  it('keeps normal URLs and shortens over-long ones to origin + path', () => {
    const short = 'https://www.amazon.in/ap/signin?x=1';
    expect(boundedWebUrl(short)).toBe(short);
    const long = `https://www.amazon.in/ap/signin?openid.return_to=${'a'.repeat(3000)}#frag`;
    const bounded = boundedWebUrl(long);
    expect(bounded).toBe('https://www.amazon.in/ap/signin');
    expect(Observation.shape.url.safeParse(bounded).success).toBe(true);
  });
});

// Live on the Mac: "summarize this page" failed on a page whose host is not a public domain.
describe('Target host', () => {
  const target = (domain: string, reason: string) =>
    Target.safeParse({ domain, url: `http://${domain}/page`, adapterId: null, reason }).success;

  it('accepts a local host or IP address for the tab that is already open', () => {
    for (const host of ['localhost', '127.0.0.1', '192.168.1.20', 'intranet', '[::1]'])
      expect(target(host, 'current-tab'), host).toBe(true);
    expect(target('en.wikipedia.org', 'current-tab')).toBe(true);
  });

  it('still requires a real domain for a site the agent navigates to', () => {
    expect(target('localhost', 'explicit-site')).toBe(false);
    expect(target('192.168.1.20', 'resolved-website')).toBe(false);
    expect(target('youtube.com', 'explicit-site')).toBe(true);
  });
});
