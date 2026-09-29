import { DEFAULT_SETTINGS } from '@techie-mind/config';
import { Task, TaskResult } from '@techie-mind/contracts';
import { createLogger, MemorySink } from '@techie-mind/telemetry';
import { describe, expect, it } from 'vitest';
import {
  canonicalize,
  resolveIntent,
  resumeTask,
  runTask,
  type RunnerDeps,
  type TaskCheckpoint,
} from '../src/index.js';
import { shop } from './shop-fixture.js';
import { node, type WorkflowSite } from './workflow-site.js';

/** Batch C/D behaviour that shipped without unit tests: languages, pause/resume, upload. */

function task(text: string, id = 'task-cd'): Task {
  return Task.parse({
    taskId: id,
    text,
    source: 'typed',
    mode: 'search',
    autonomy: 'act-without-asking',
    language: 'unknown',
    status: 'RUNNING',
    createdAt: 0,
    maxSteps: DEFAULT_SETTINGS.agent.maxSteps,
    skillId: null,
  });
}

function deps(site: WorkflowSite, extra: Partial<RunnerDeps> = {}): RunnerDeps {
  return {
    host: site,
    logger: createLogger({ component: 'agent', sinks: [new MemorySink(500)], level: 'debug' }),
    settings: DEFAULT_SETTINGS,
    ...extra,
  };
}

describe('multilingual — the same intent in any language (spec §45)', () => {
  const cases: Array<
    [string, { action: string; domain: string | null; query: string | null; language: string }]
  > = [
    [
      'ಯೂಟ್ಯೂಬ್‌ನಲ್ಲಿ ಕನ್ನಡ ಹಾಡುಗಳನ್ನು ಪ್ಲೇ ಮಾಡಿ',
      { action: 'search_and_play', domain: 'youtube.com', query: 'ಕನ್ನಡ ಹಾಡುಗಳು', language: 'kn' },
    ],
    [
      'अमेज़न पर काले जूते ढूंढो',
      { action: 'search', domain: 'amazon.in', query: 'काले जूते', language: 'hi' },
    ],
    [
      'யூடியூபில் தமிழ் பாடல்கள் ப்ளே பண்ணு',
      { action: 'search_and_play', domain: 'youtube.com', query: 'தமிழ் பாடல்கள்', language: 'ta' },
    ],
    [
      'యూట్యూబ్‌లో తెలుగు పాటలు ప్లే చేయి',
      { action: 'search_and_play', domain: 'youtube.com', query: 'తెలుగు పాటలు', language: 'te' },
    ],
    ['वापस जाओ', { action: 'go_back', domain: null, query: null, language: 'hi' }],
    ['ಹಿಂದೆ ಹೋಗು', { action: 'go_back', domain: null, query: null, language: 'kn' }],
    ['कार्ट में डालो', { action: 'add_to_cart', domain: null, query: null, language: 'hi' }],
  ];
  for (const [text, want] of cases) {
    it(`"${text}" → ${want.action}`, () => {
      const p = resolveIntent(text).profile;
      expect(p.action).toBe(want.action);
      expect(p.targetDomain).toBe(want.domain);
      expect(p.query).toBe(want.query);
      expect(p.language).toBe(want.language);
    });
  }

  it('price limits in Hindi and romanized Hindi become constraints', () => {
    for (const text of [
      'फ्लिपकार्ट पर ₹50,000 से कम लैपटॉप ढूंढो',
      'flipkart pe 50000 se kam laptop dhoondo',
    ]) {
      const p = resolveIntent(text).profile;
      expect(p.targetDomain).toBe('flipkart.com');
      expect(p.constraints).toEqual([
        expect.objectContaining({ field: 'price', op: '<=', value: 50000 }),
      ]);
    }
  });

  it('"cheapest" in Hindi and Kannada picks by value', () => {
    expect(resolveIntent('सबसे सस्ता वाला खोलो').profile.action).toBe('pick_item');
    expect(resolveIntent('ಅಗ್ಗದ ಫೋನ್ ತೆರೆ').profile.action).toBe('pick_item');
  });

  it('English text is never rewritten', () => {
    for (const text of [
      'play Kannada songs on YouTube',
      'open flipkart iphone',
      'search for pan cards',
    ]) {
      expect(canonicalize(text)).toBe(text);
    }
  });
});

describe('pause, stop and resume (spec §25–26)', () => {
  it('pause keeps a checkpoint; continue finishes the same plan', async () => {
    const site = shop('/search?q=laptops');
    let checkpoint: TaskCheckpoint | null = null;
    const paused = await runTask(
      task('open the cheapest one'),
      deps(site, {
        control: { pause: true, stop: false },
        onCheckpoint: (cp) => (checkpoint = cp),
      }),
    );
    expect(paused.status).toBe('PAUSED');
    expect(paused.handover).toMatchObject({ reason: 'paused', resumable: true });
    expect(site.path).toBe('/search?q=laptops');
    expect(checkpoint).not.toBeNull();

    const resumed = await resumeTask(checkpoint!, 'continue', deps(site), 'task-cd-2');
    expect(TaskResult.safeParse(resumed).success).toBe(true);
    expect(resumed.status).toBe('COMPLETED');
    expect(site.path).toMatch(/^\/p\//);
  });

  it('stop ends the task before the next step', async () => {
    const site = shop('/search?q=laptops');
    const result = await runTask(
      task('open the cheapest one'),
      deps(site, { control: { pause: false, stop: true } }),
    );
    expect(result.status).toBe('CANCELLED');
    expect(site.executed).toHaveLength(0);
  });

  it('an expired checkpoint is refused', async () => {
    const site = shop('/search?q=laptops');
    let checkpoint: TaskCheckpoint | null = null;
    await runTask(
      task('open the cheapest one'),
      deps(site, {
        control: { pause: true, stop: false },
        onCheckpoint: (cp) => (checkpoint = cp),
      }),
    );
    const late = await resumeTask(
      { ...checkpoint!, expiresAt: 0 },
      'continue',
      deps(site, { now: () => 10 }),
      'task-cd-3',
    );
    expect(late.status).toBe('FAILED');
    expect(late.error?.code).toBe('RESUME_EXPIRED');
  });

  it('the checkout control is never pressed: a payment handover that cannot be continued', async () => {
    const site = shop('/cart');
    const result = await runTask(task('proceed to checkout'), deps(site));
    expect(result.status).toBe('HUMAN_REQUIRED');
    expect(result.handover).toMatchObject({ reason: 'payment', resumable: false });
    expect(site.path).toBe('/cart');
  });
});

describe('upload the attached file (Batch D)', () => {
  function uploadSite() {
    const site = shop('/address');
    site.pages['/upload'] = {
      title: 'Upload your resume',
      nodes: [
        node({ nodeId: 'label', tag: 'button', name: 'Choose file' }),
        // File fields are usually hidden behind a styled button.
        node({
          nodeId: 'resume',
          tag: 'input',
          inputType: 'file',
          name: 'Resume',
          visible: false,
          bbox: null,
        }),
      ],
    };
    site.go('/upload');
    return site;
  }
  const attachment = {
    fileRef: 'file-1',
    name: 'resume.pdf',
    mime: 'application/pdf',
    size: 2048,
    base64: 'JVBERi0xLjQ=',
  };

  it('"upload it" puts the attached file into the (hidden) file field, verified, not submitted', async () => {
    const site = uploadSite();
    const result = await runTask(task('upload it'), deps(site, { attachment }));
    expect(result.status).toBe('COMPLETED');
    expect(site.values.get('resume')).toBe('resume.pdf');
    expect(result.steps.at(-1)?.evidence).toMatch(/resume\.pdf.*not submitted/);
  });

  it('without an attached file it asks for one and touches nothing', async () => {
    const site = uploadSite();
    const result = await runTask(task('upload it'), deps(site));
    expect(result.status).toBe('HUMAN_REQUIRED');
    expect(result.error?.message).toMatch(/paperclip/);
    expect(site.executed).toHaveLength(0);
  });
});
