import {
  DERIVED_ATTR,
  type AccessibilityNode,
  type DOMNode,
  type Observation,
} from '@techie-mind/contracts';
import { computeName, computeRole, computeStates, nearestLandmark } from './accessibility.js';
import type { ElementRegistry } from './registry.js';

/**
 * DOM observer (perception level 1). Collects the interactive and semantic elements of the current
 * document — including open shadow roots — with role, accessible name, geometry and visibility.
 * Runs entirely inside the page; the observation stays local (spec §13).
 */

const CANDIDATE_SELECTOR = [
  'a[href]',
  'button',
  'input',
  'textarea',
  'select',
  'summary',
  '[role]',
  '[contenteditable=""]',
  '[contenteditable="true"]',
  '[tabindex]:not([tabindex="-1"])',
  'h1',
  'h2',
  'h3',
  'video',
  'audio',
].join(',');

const INTERACTIVE_ROLES = new Set([
  'button',
  'link',
  'textbox',
  'searchbox',
  'combobox',
  'checkbox',
  'radio',
  'slider',
  'spinbutton',
  'switch',
  'tab',
  'menuitem',
  'option',
  'listbox',
]);
const EDITABLE_ROLES = new Set(['textbox', 'searchbox', 'combobox', 'spinbutton']);
const ATTRIBUTE_KEYS = [
  'id',
  'name',
  'type',
  'placeholder',
  'aria-label',
  'title',
  'autocomplete',
  'role',
  'href',
  'class',
];

export const MAX_NODES = 1500;

export interface ObserveOptions {
  taskId: string;
  observationId: string;
  tabId: number;
  documentId: string;
  version: number;
  registry: ElementRegistry;
  now: number;
}

/** All candidate elements in document order, descending into open shadow roots. */
function collectCandidates(root: Document | ShadowRoot, out: Element[]): void {
  for (const el of Array.from(root.querySelectorAll(CANDIDATE_SELECTOR))) out.push(el);
  const SHOW_ELEMENT = 0x1; // NodeFilter.SHOW_ELEMENT (constant; avoids relying on a global)
  const doc = root.ownerDocument ?? (root as Document);
  const walker = doc.createTreeWalker(root, SHOW_ELEMENT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const shadow = (node as Element).shadowRoot;
    if (shadow) collectCandidates(shadow, out);
  }
}

export function isVisible(el: Element): boolean {
  if (!el.isConnected) return false;
  const html = el as HTMLElement;
  if (
    typeof html.checkVisibility === 'function' &&
    !html.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })
  ) {
    return false;
  }
  const rect = el.getBoundingClientRect();
  return rect.width > 1 && rect.height > 1;
}

export function isEditable(el: Element, role: string | null): boolean {
  const html = el as HTMLInputElement;
  if (html.disabled || html.readOnly) return false;
  if (el.localName === 'input') {
    return ![
      'checkbox',
      'radio',
      'submit',
      'button',
      'reset',
      'image',
      'file',
      'range',
      'color',
      'hidden',
    ].includes((html.type || 'text').toLowerCase());
  }
  if (el.localName === 'textarea') return true;
  if ((el as HTMLElement).isContentEditable) return true;
  return role !== null && EDITABLE_ROLES.has(role) && el.localName !== 'select';
}

function valueOf(el: Element): string | null {
  if (el.localName === 'input' || el.localName === 'textarea' || el.localName === 'select') {
    return (el as HTMLInputElement).value.slice(0, 2000);
  }
  if ((el as HTMLElement).isContentEditable) return (el.textContent ?? '').slice(0, 2000);
  return null;
}

function owningForm(el: Element): HTMLFormElement | null {
  const control = el as HTMLInputElement;
  return control.form ?? el.closest('form');
}

function formAttributes(
  form: HTMLFormElement | null,
  registry: ElementRegistry,
): {
  formId: string | null;
  role: string | null;
  action: string | null;
} {
  if (!form) return { formId: null, role: null, action: null };
  const role = form.getAttribute('role') === 'search' || form.closest('search') ? 'search' : null;
  let action: string | null = null;
  const raw = form.getAttribute('action');
  if (raw) {
    try {
      action = new URL(raw, form.ownerDocument.baseURI).pathname.slice(0, 200);
    } catch {
      action = null;
    }
  }
  return { formId: registry.idFor(form), role, action };
}

function attributesOf(el: Element): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of ATTRIBUTE_KEYS) {
    const value = el.getAttribute(key);
    if (value !== null) out[key] = value.slice(0, key === 'href' ? 512 : 200);
  }
  return out;
}

function textFor(el: Element, role: string | null): string | null {
  if (
    role === 'link' ||
    role === 'button' ||
    role === 'heading' ||
    role === 'option' ||
    role === 'tab'
  ) {
    const inner = (el as HTMLElement).innerText ?? el.textContent ?? '';
    const text = inner.replace(/\s+/g, ' ').trim();
    return text ? text.slice(0, 300) : null;
  }
  return null;
}

/** Priority for the node cap: editable fields, then buttons, then everything else in page order. */
function priority(node: DOMNode): number {
  if (!node.visible) return 3;
  if (node.editable) return 0;
  if (node.role === 'button' || node.tag === 'button') return 1;
  return 2;
}

export function observeDocument(doc: Document, opts: ObserveOptions): Observation {
  const candidates: Element[] = [];
  collectCandidates(doc, candidates);
  const seen = new Set<Element>();
  const nodes: DOMNode[] = [];

  for (const el of candidates) {
    if (seen.has(el)) continue;
    seen.add(el);
    const role = computeRole(el);
    const interactive =
      (role !== null && INTERACTIVE_ROLES.has(role)) ||
      el.localName === 'button' ||
      el.localName === 'summary' ||
      (el.localName === 'input' && (el as HTMLInputElement).type !== 'hidden');
    const semantic = role === 'heading' || el.localName === 'video' || el.localName === 'audio';
    if (!interactive && !semantic) continue;

    const visible = isVisible(el);
    const rect = el.getBoundingClientRect();
    const form = formAttributes(owningForm(el), opts.registry);
    const attributes = attributesOf(el);
    if (form.role) attributes[DERIVED_ATTR.formRole] = form.role;
    if (form.action) attributes[DERIVED_ATTR.formAction] = form.action;
    const landmark = nearestLandmark(el);
    if (landmark) attributes[DERIVED_ATTR.landmark] = landmark;

    const editable = isEditable(el, role);
    const parent = el.parentElement;
    nodes.push({
      nodeId: opts.registry.idFor(el),
      parentId: parent ? opts.registry.idFor(parent) : null,
      tag: el.localName.slice(0, 64),
      role,
      name: computeName(el),
      text: textFor(el, role),
      attributes,
      inputType:
        el.localName === 'input' ? ((el as HTMLInputElement).type || 'text').toLowerCase() : null,
      formId: form.formId,
      value: editable ? valueOf(el) : null,
      visible,
      interactive,
      editable,
      bbox: visible
        ? {
            x: Math.round(rect.x + (doc.defaultView?.scrollX ?? 0)),
            y: Math.round(rect.y + (doc.defaultView?.scrollY ?? 0)),
            width: Math.round(rect.width),
            height: Math.round(rect.height),
          }
        : null,
    });
  }

  const kept = nodes
    .map((node, index) => ({ node, index }))
    .sort((a, b) => priority(a.node) - priority(b.node) || a.index - b.index)
    .slice(0, MAX_NODES)
    .sort((a, b) => a.index - b.index)
    .map((x) => x.node);

  const a11yNodes: AccessibilityNode[] = kept
    .filter((n) => n.role !== null)
    .map((n) => {
      const el = opts.registry.get(n.nodeId);
      return {
        nodeId: `ax-${n.nodeId}`,
        domNodeId: n.nodeId,
        role: n.role ?? 'generic',
        name: n.name ?? '',
        value: n.value,
        states: el ? computeStates(el, n.visible) : [],
        childIds: [],
      };
    });

  const win = doc.defaultView;
  const url = doc.location.href;
  return {
    observationId: opts.observationId,
    taskId: opts.taskId,
    tabId: opts.tabId,
    documentId: opts.documentId,
    origin: doc.location.origin,
    url,
    title: doc.title.slice(0, 512),
    version: opts.version,
    createdAt: opts.now,
    viewport: {
      width: Math.max(1, Math.round(win?.innerWidth ?? 1)),
      height: Math.max(1, Math.round(win?.innerHeight ?? 1)),
      scrollX: win?.scrollX ?? 0,
      scrollY: win?.scrollY ?? 0,
      devicePixelRatio: win?.devicePixelRatio ?? 1,
    },
    domNodes: kept,
    a11yNodes,
    visualRegions: [],
  };
}
