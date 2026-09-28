import {
  elementFingerprint,
  TARGETED_ACTIONS,
  type Action,
  type ExecuteRejection,
  type ExecuteResponse,
  type ProbeResponse,
} from '@techie-mind/contracts';
import { computeName, computeRole } from './accessibility.js';
import { isEditable, isVisible } from './observer.js';
import type { ActivityOverlay } from './overlay.js';
import type { DomVersion, ElementRegistry } from './registry.js';

/**
 * Page-side browser executor (master plan §12). Executes one already-validated, bound Action.
 * Before touching the page it re-checks the binding against the live document: document id,
 * origin, element existence, fingerprint, visibility and enabled state. No code from the action
 * is ever evaluated — only the fixed primitives below exist.
 */
export interface PageContext {
  doc: Document;
  documentId: string;
  registry: ElementRegistry;
  version: DomVersion;
  overlay: ActivityOverlay | null;
}

export interface Execution {
  response: ExecuteResponse;
  /** Navigation-capable side effect, run after the response has been sent. */
  deferred: (() => void) | null;
}

/** Actions performed by the background (NAVIGATE, WAIT) or by later phases never run here. */
const PAGE_ACTIONS = new Set([
  'CLICK',
  'TYPE',
  'CLEAR',
  'SELECT',
  'SCROLL',
  'PRESS_KEY',
  'HIGHLIGHT',
  'FOCUS',
  'HOVER',
]);

function respond(
  ctx: PageContext,
  action: Action,
  status: ExecuteResponse['status'],
  code: ExecuteRejection | null,
  message: string,
  valueAfter: string | null = null,
  deferred = false,
): ExecuteResponse {
  return {
    type: 'EXECUTE_RESULT',
    actionId: action.actionId,
    status,
    code,
    message: message.slice(0, 500),
    valueAfter,
    versionAfter: ctx.version.value,
    deferred,
  };
}

function reject(
  ctx: PageContext,
  action: Action,
  code: ExecuteRejection,
  message: string,
): Execution {
  return { response: respond(ctx, action, 'rejected', code, message), deferred: null };
}

function currentValue(el: Element): string | null {
  if (el.localName === 'input' || el.localName === 'textarea' || el.localName === 'select') {
    return (el as HTMLInputElement).value;
  }
  if ((el as HTMLElement).isContentEditable) return el.textContent ?? '';
  return null;
}

/** Set a value the way frameworks observe it: native setter + input/change events. */
function setValue(el: Element, value: string): void {
  const win = el.ownerDocument.defaultView;
  if (!win) return;
  if (el.localName === 'input' || el.localName === 'textarea') {
    const proto =
      el.localName === 'input' ? win.HTMLInputElement.prototype : win.HTMLTextAreaElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    setter?.call(el, value);
  } else if ((el as HTMLElement).isContentEditable) {
    el.textContent = value;
  }
  el.dispatchEvent(
    new win.InputEvent('input', {
      bubbles: true,
      composed: true,
      inputType: 'insertText',
      data: value,
    }),
  );
  el.dispatchEvent(new win.Event('change', { bubbles: true }));
}

function keyEvent(el: Element, type: string, key: string): boolean {
  const win = el.ownerDocument.defaultView;
  if (!win) return false;
  const code = key === 'Space' ? 'Space' : key;
  const keyCode = key === 'Enter' ? 13 : key === 'Escape' ? 27 : key === 'Tab' ? 9 : 0;
  return el.dispatchEvent(
    new win.KeyboardEvent(type, {
      key: key === 'Space' ? ' ' : key,
      code,
      keyCode,
      bubbles: true,
      cancelable: true,
      composed: true,
    }),
  );
}

/**
 * Enter in a text field: dispatch the key sequence; if the page did not cancel it and the field
 * belongs to a form, perform implicit submission (HTML: Enter in a form field submits the form).
 */
function pressEnter(el: Element): void {
  const down = keyEvent(el, 'keydown', 'Enter');
  const press = keyEvent(el, 'keypress', 'Enter');
  keyEvent(el, 'keyup', 'Enter');
  const form = (el as HTMLInputElement).form ?? el.closest('form');
  if (down && press && form && form.isConnected) form.requestSubmit();
}

function pointerSequence(el: Element): void {
  const win = el.ownerDocument.defaultView;
  if (!win) return;
  const rect = el.getBoundingClientRect();
  const init = {
    bubbles: true,
    cancelable: true,
    composed: true,
    clientX: rect.left + rect.width / 2,
    clientY: rect.top + rect.height / 2,
    button: 0,
  };
  const Pointer = win.PointerEvent ?? win.MouseEvent;
  el.dispatchEvent(new Pointer('pointerover', init));
  el.dispatchEvent(new Pointer('pointerdown', init));
  el.dispatchEvent(new win.MouseEvent('mousedown', init));
  (el as HTMLElement).focus?.({ preventScroll: true });
  el.dispatchEvent(new Pointer('pointerup', init));
  el.dispatchEvent(new win.MouseEvent('mouseup', init));
  (el as HTMLElement).click();
}

/** Delay before a deferred action fires, so the highlight is visible first. */
export const DEFER_MS = 150;

export function executeAction(action: Action, ctx: PageContext): Execution {
  const { binding, args } = action;
  if (binding.documentId !== ctx.documentId) {
    return reject(ctx, action, 'DOCUMENT_MISMATCH', 'action was planned for a different document');
  }
  if (binding.origin !== ctx.doc.location.origin) {
    return reject(ctx, action, 'ORIGIN_MISMATCH', `action origin ${binding.origin} ≠ page origin`);
  }
  if (binding.observationVersion > ctx.version.value) {
    return reject(
      ctx,
      action,
      'STALE_OBSERVATION',
      'observation version is ahead of the live document',
    );
  }
  if (!PAGE_ACTIONS.has(args.type)) {
    return reject(ctx, action, 'UNSUPPORTED_ACTION', `${args.type} is not executed in the page`);
  }

  let el: Element | null = null;
  if (binding.target) {
    if (binding.target.kind !== 'element') {
      return reject(
        ctx,
        action,
        'UNSUPPORTED_ACTION',
        'visual-region targets arrive with visual perception',
      );
    }
    el = ctx.registry.get(binding.target.elementId);
    if (!el)
      return reject(
        ctx,
        action,
        'TARGET_MISSING',
        `element ${binding.target.elementId} no longer exists`,
      );
    if (!el.isConnected)
      return reject(ctx, action, 'TARGET_DETACHED', 'element was removed from the page');
    if (binding.target.fingerprint) {
      const live = elementFingerprint(el.localName, computeRole(el), computeName(el));
      if (live !== binding.target.fingerprint) {
        return reject(ctx, action, 'TARGET_CHANGED', 'element identity changed since observation');
      }
    }
  } else if (TARGETED_ACTIONS.has(args.type)) {
    return reject(ctx, action, 'TARGET_MISSING', `${args.type} needs a target`);
  }

  if (el && args.type !== 'SCROLL' && args.type !== 'HIGHLIGHT') {
    if (!isVisible(el)) {
      el.scrollIntoView({ block: 'center', inline: 'nearest' });
      if (!isVisible(el)) return reject(ctx, action, 'TARGET_HIDDEN', 'element is not visible');
    }
    const html = el as HTMLInputElement;
    if (html.disabled || el.getAttribute('aria-disabled') === 'true') {
      return reject(ctx, action, 'TARGET_DISABLED', 'element is disabled');
    }
  }

  switch (args.type) {
    case 'TYPE': {
      if (!el || !isEditable(el, computeRole(el)))
        return reject(ctx, action, 'TARGET_NOT_EDITABLE', 'element does not accept text');
      if (!('text' in args.input)) {
        return reject(
          ctx,
          action,
          'UNSUPPORTED_ACTION',
          'vault-token input is resolved by the privacy vault (Phase 2)',
        );
      }
      ctx.overlay?.show(el, 'Typing');
      el.scrollIntoView({ block: 'center', inline: 'nearest' });
      (el as HTMLElement).focus({ preventScroll: true });
      if (!el.isConnected) {
        return {
          response: respond(
            ctx,
            action,
            'failed',
            'TARGET_DETACHED',
            'element was replaced when focused',
          ),
          deferred: null,
        };
      }
      setValue(el, args.input.text);
      const valueAfter = currentValue(el);
      const target = el;
      return {
        response: respond(
          ctx,
          action,
          'executed',
          null,
          `typed ${args.input.text.length} characters${args.submit ? ', submitting' : ''}`,
          valueAfter,
          args.submit,
        ),
        deferred: args.submit ? () => pressEnter(target) : null,
      };
    }
    case 'CLEAR': {
      if (!el || !isEditable(el, computeRole(el)))
        return reject(ctx, action, 'TARGET_NOT_EDITABLE', 'element does not accept text');
      setValue(el, '');
      return {
        response: respond(ctx, action, 'executed', null, 'cleared', currentValue(el)),
        deferred: null,
      };
    }
    case 'SELECT': {
      if (!el || el.localName !== 'select')
        return reject(ctx, action, 'TARGET_NOT_EDITABLE', 'element is not a select');
      const select = el as HTMLSelectElement;
      const option = Array.from(select.options).find(
        (o) => o.value === args.value || o.text.trim() === args.value,
      );
      if (!option)
        return {
          response: respond(ctx, action, 'failed', null, 'option not found'),
          deferred: null,
        };
      setValue(select, option.value);
      return {
        response: respond(
          ctx,
          action,
          'executed',
          null,
          `selected ${option.text.trim().slice(0, 60)}`,
          select.value,
        ),
        deferred: null,
      };
    }
    case 'CLICK': {
      const target = el as Element;
      ctx.overlay?.show(target, 'Clicking');
      target.scrollIntoView({ block: 'center', inline: 'nearest' });
      return {
        response: respond(ctx, action, 'executed', null, 'click dispatched', null, true),
        deferred: () => pointerSequence(target),
      };
    }
    case 'PRESS_KEY': {
      const target = el ?? ctx.doc.activeElement ?? ctx.doc.body;
      if (args.key === 'Enter') {
        return {
          response: respond(ctx, action, 'executed', null, 'Enter pressed', null, true),
          deferred: () => pressEnter(target),
        };
      }
      keyEvent(target, 'keydown', args.key);
      keyEvent(target, 'keyup', args.key);
      return {
        response: respond(ctx, action, 'executed', null, `${args.key} pressed`),
        deferred: null,
      };
    }
    case 'FOCUS':
      (el as HTMLElement).focus();
      return { response: respond(ctx, action, 'executed', null, 'focused'), deferred: null };
    case 'HOVER': {
      const win = ctx.doc.defaultView;
      if (el && win) {
        el.dispatchEvent(
          new (win.PointerEvent ?? win.MouseEvent)('pointerover', { bubbles: true }),
        );
        el.dispatchEvent(new win.MouseEvent('mouseover', { bubbles: true }));
      }
      return { response: respond(ctx, action, 'executed', null, 'hovered'), deferred: null };
    }
    case 'HIGHLIGHT':
      if (el) ctx.overlay?.show(el, 'Looking here');
      return { response: respond(ctx, action, 'executed', null, 'highlighted'), deferred: null };
    case 'SCROLL': {
      const win = ctx.doc.defaultView;
      if (args.direction === 'into-view' && el) el.scrollIntoView({ block: 'center' });
      else if (win) {
        const delta = args.amount ?? Math.round(win.innerHeight * 0.8);
        win.scrollBy({ top: args.direction === 'up' ? -delta : delta });
      }
      return {
        response: respond(ctx, action, 'executed', null, `scrolled ${args.direction}`),
        deferred: null,
      };
    }
    default:
      return reject(ctx, action, 'UNSUPPORTED_ACTION', `${args.type} is not executed in the page`);
  }
}

export function probePage(ctx: PageContext, elementId: string | null): ProbeResponse {
  let element: ProbeResponse['element'] = null;
  if (elementId) {
    const el = ctx.registry.get(elementId);
    element = el
      ? {
          exists: el.isConnected,
          visible: isVisible(el),
          value: currentValue(el)?.slice(0, 2000) ?? null,
        }
      : { exists: false, visible: false, value: null };
  }
  const primary = primaryMedia(ctx.doc);
  return {
    type: 'PROBE_RESULT',
    url: ctx.doc.location.href.slice(0, 2048),
    origin: ctx.doc.location.origin,
    title: ctx.doc.title.slice(0, 512),
    documentId: ctx.documentId,
    version: ctx.version.value,
    readyState: ctx.doc.readyState,
    element,
    media: {
      present: primary !== null,
      playing: primary !== null && !primary.paused && !primary.ended && primary.readyState > 2,
      currentTime: primary && Number.isFinite(primary.currentTime) ? primary.currentTime : null,
    },
  };
}

/** Minimum on-screen area for media to count as the page's main player (≈ 120×90). */
const PRIMARY_MEDIA_MIN_AREA = 10_800;

/** The largest visible media element — the page's main player, not hover/preview players. */
export function primaryMedia(doc: Document): HTMLMediaElement | null {
  let best: HTMLMediaElement | null = null;
  let bestArea = 0;
  for (const m of Array.from(doc.querySelectorAll('video, audio')) as HTMLMediaElement[]) {
    if (!isVisible(m)) continue;
    const rect = m.getBoundingClientRect();
    const area = rect.width * rect.height;
    if (area >= PRIMARY_MEDIA_MIN_AREA && area > bestArea) {
      best = m;
      bestArea = area;
    }
  }
  return best;
}
