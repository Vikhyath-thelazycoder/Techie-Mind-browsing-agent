import { DERIVED_ATTR, Observation } from '@techie-mind/contracts';
import { describe, expect, it } from 'vitest';
import { computeName, computeRole, nearestLandmark, observeDocument } from '../src/index.js';
import { makePage } from './dom.js';

const PAGE = `
<header>
  <form role="search" action="/search">
    <input type="search" name="q" placeholder="Search products">
    <button type="submit" aria-label="Search"><svg></svg></button>
  </form>
</header>
<main>
  <label for="mail">Newsletter</label><input id="mail" type="email">
  <input type="text" hidden name="hidden-field">
  <a href="/p/1">Trail running shoes for men</a>
  <h2>Deals</h2>
  <div role="button" tabindex="0">Menu</div>
  <textarea aria-labelledby="lbl"></textarea><span id="lbl">Your review</span>
</main>`;

function observe(html = PAGE) {
  const { ctx } = makePage(html);
  const obs = observeDocument(ctx.doc, {
    taskId: 'task-1',
    observationId: 'obs-1',
    tabId: 3,
    documentId: ctx.documentId,
    version: ctx.version.value,
    registry: ctx.registry,
    now: 1,
  });
  return { ctx, obs };
}

describe('accessibility projection', () => {
  it('computes implicit and explicit roles', () => {
    const { ctx } = makePage(PAGE);
    const q = (s: string) => ctx.doc.querySelector(s)!;
    expect(computeRole(q('input[type=search]'))).toBe('searchbox');
    expect(computeRole(q('#mail'))).toBe('textbox');
    expect(computeRole(q('a'))).toBe('link');
    expect(computeRole(q('[role=button]'))).toBe('button');
    expect(computeRole(q('textarea'))).toBe('textbox');
  });

  it('computes accessible names in accname precedence order', () => {
    const { ctx } = makePage(PAGE);
    const q = (s: string) => ctx.doc.querySelector(s)!;
    expect(computeName(q('input[type=search]'))).toBe('Search products'); // placeholder fallback
    expect(computeName(q('#mail'))).toBe('Newsletter'); // <label for>
    expect(computeName(q('button'))).toBe('Search'); // aria-label
    expect(computeName(q('textarea'))).toBe('Your review'); // aria-labelledby
    expect(computeName(q('a'))).toBe('Trail running shoes for men'); // content
  });

  it('finds the nearest landmark', () => {
    const { ctx } = makePage(PAGE);
    expect(nearestLandmark(ctx.doc.querySelector('input[type=search]')!)).toBe('search');
    expect(nearestLandmark(ctx.doc.querySelector('a')!)).toBe('main');
  });
});

describe('DOM observer', () => {
  it('produces a contract-valid observation', () => {
    const { obs } = observe();
    expect(Observation.safeParse(obs).success).toBe(true);
    expect(obs.origin).toBe('https://shop.example.test');
    expect(obs.tabId).toBe(3);
  });

  it('captures roles, names, form semantics and landmarks', () => {
    const { obs } = observe();
    const search = obs.domNodes.find((n) => n.inputType === 'search')!;
    expect(search).toMatchObject({ role: 'searchbox', editable: true, visible: true, value: '' });
    expect(search.attributes[DERIVED_ATTR.formRole]).toBe('search');
    expect(search.attributes[DERIVED_ATTR.formAction]).toBe('/search');
    const button = obs.domNodes.find((n) => n.tag === 'button')!;
    expect(button.formId).toBe(search.formId);
    expect(obs.domNodes.find((n) => n.tag === 'h2')?.role).toBe('heading');
  });

  it('marks hidden controls invisible and excludes type=hidden inputs', () => {
    const { obs } = observe();
    const hidden = obs.domNodes.find((n) => n.attributes['name'] === 'hidden-field');
    expect(hidden?.visible).toBe(false);
    expect(obs.domNodes.some((n) => n.inputType === 'hidden')).toBe(false);
  });

  it('keeps element ids stable across observations of the same document', () => {
    const { ctx, obs } = observe();
    const again = observeDocument(ctx.doc, {
      taskId: 'task-1',
      observationId: 'obs-2',
      tabId: 3,
      documentId: ctx.documentId,
      version: ctx.version.value,
      registry: ctx.registry,
      now: 2,
    });
    const id = (o: typeof obs) => o.domNodes.find((n) => n.inputType === 'search')!.nodeId;
    expect(id(again)).toBe(id(obs));
  });

  it('builds an accessibility node for every role-bearing DOM node', () => {
    const { obs } = observe();
    const withRole = obs.domNodes.filter((n) => n.role !== null);
    expect(obs.a11yNodes).toHaveLength(withRole.length);
    expect(obs.a11yNodes.every((a) => a.domNodeId !== null)).toBe(true);
  });

  it('descends into open shadow roots', () => {
    const { ctx } = makePage('<div id="host"></div>');
    const root = ctx.doc.getElementById('host')!.attachShadow({ mode: 'open' });
    const input = ctx.doc.createElement('input');
    input.setAttribute('aria-label', 'Search videos');
    root.append(input);
    const obs = observeDocument(ctx.doc, {
      taskId: 't',
      observationId: 'o',
      tabId: 1,
      documentId: ctx.documentId,
      version: 0,
      registry: ctx.registry,
      now: 0,
    });
    expect(obs.domNodes.some((n) => n.name === 'Search videos')).toBe(true);
  });
});
