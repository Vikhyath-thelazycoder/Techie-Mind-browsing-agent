import type { Action, DOMNode } from '@techie-mind/contracts';
import { detectField } from '@techie-mind/privacy';

/**
 * Action risk classification (plan §24, spec §24 financial safety).
 *   LOW            read / scroll / highlight / search
 *   MEDIUM         navigation, ordinary form typing, add to cart
 *   HIGH           account changes, deletion, publishing, sending messages, uploads
 *   HUMAN_REQUIRED OTP, CAPTCHA, passwords, card data, payment / purchase authorization
 *   BLOCKED        unsafe or prohibited (non-web navigation, script URLs, raw password typing)
 * Classification uses the target's semantics (role, accessible name, href, field kind) — never a
 * site list.
 */
export type RiskClass = 'LOW' | 'MEDIUM' | 'HIGH' | 'HUMAN_REQUIRED' | 'BLOCKED';

export interface RiskAssessment {
  level: RiskClass;
  reasons: string[];
  /** For HUMAN_REQUIRED: what the user must do. */
  handover: 'payment' | 'otp' | 'captcha' | 'login' | null;
}

const ORDER: RiskClass[] = ['LOW', 'MEDIUM', 'HIGH', 'HUMAN_REQUIRED', 'BLOCKED'];
export function atLeast(level: RiskClass, floor: RiskClass): boolean {
  return ORDER.indexOf(level) >= ORDER.indexOf(floor);
}

/** Controls that authorize money moving. Anchored: they describe what the control DOES. */
const PAYMENT =
  /^(?:pay\b|pay now|make (?:a )?payment|proceed to (?:pay|payment|checkout)|place (?:your )?order|buy now|buy\b.*\bpay\b|confirm (?:and pay|order|purchase|payment)|complete (?:purchase|payment|order)|checkout|check out|transfer|send money|upi pay|authori[sz]e|subscribe (?:now|and pay)|start (?:subscription|trial)|confirm booking)/i;
const PAYMENT_HREF =
  /\/(?:checkout|payment|payments|pay|billing|purchase|order\/confirm)(?:[/?#]|$)/i;
const CAPTCHA = /captcha|i'?m not a robot|verify (?:you are|that you're) human/i;
const DESTRUCTIVE =
  /^(?:delete|remove (?:account|all|permanently)|deactivate|close (?:my )?account|erase|wipe|revoke|cancel (?:my )?(?:subscription|account|order)|unsubscribe)/i;
const PUBLISH =
  /^(?:send|post|publish|tweet|share|reply|comment|submit (?:review|comment|post|application)|follow|subscribe|like|upvote|invite|save changes|update (?:profile|password|email)|change (?:password|email))/i;
const ADD_TO_CART = /^(?:add to (?:cart|bag|basket)|add to wishlist)/i;

function label(node: DOMNode | null): string {
  if (!node) return '';
  return [node.name, node.text, node.attributes['aria-label'], node.attributes['value']]
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** A long link label is content (a result title), not a command; only its destination speaks. */
const CONTENT_LINK_LENGTH = 40;

export function classifyRisk(action: Action, target: DOMNode | null): RiskAssessment {
  const a = action.args;
  const r = (
    level: RiskClass,
    reason: string,
    handover: RiskAssessment['handover'] = null,
  ): RiskAssessment => ({ level, reasons: [reason], handover });

  switch (a.type) {
    case 'SCROLL':
    case 'HIGHLIGHT':
    case 'FOCUS':
    case 'HOVER':
    case 'WAIT':
    case 'EXTRACT':
    case 'DONE':
    case 'HANDOVER':
      return r('LOW', `${a.type} does not change anything`);
    case 'UPLOAD':
      return r('HIGH', 'uploading a file shares local data');
    case 'NAVIGATE': {
      const protocol = safeProtocol(a.url);
      if (protocol !== 'https:' && protocol !== 'http:') return r('BLOCKED', 'non-web navigation');
      if (PAYMENT_HREF.test(safePath(a.url))) return r('HUMAN_REQUIRED', 'payment page', 'payment');
      return r('MEDIUM', 'navigation');
    }
    case 'PRESS_KEY':
      return a.key === 'Enter' ? r('MEDIUM', 'Enter can submit a form') : r('LOW', 'key press');
    case 'SELECT':
    case 'CLEAR':
      return r('MEDIUM', `${a.type} changes a form value`);
    case 'TYPE': {
      const field = target ? detectField(target) : null;
      const vault = 'vaultToken' in a.input;
      if (field?.kind === 'password') {
        return vault
          ? r('HUMAN_REQUIRED', 'signing in needs you', 'login')
          : r('BLOCKED', 'raw text into a password field');
      }
      if (field?.kind === 'otp') {
        return r('HUMAN_REQUIRED', 'one-time codes are entered by you', 'otp');
      }
      if (field?.kind === 'card_number' || field?.kind === 'cvv') {
        return r('HUMAN_REQUIRED', 'card details are entered by you', 'payment');
      }
      if (field) return r('HIGH', `personal data field (${field.kind})`);
      if (target && isSearchField(target)) return r('LOW', 'search');
      return r('MEDIUM', 'form typing');
    }
    case 'CLICK': {
      const text = label(target);
      const href = target?.attributes['href'] ?? '';
      if (/^\s*javascript:/i.test(href)) return r('BLOCKED', 'script URL');
      if (CAPTCHA.test(text) || /recaptcha|hcaptcha/i.test(target?.attributes['src'] ?? '')) {
        return r('HUMAN_REQUIRED', 'human-verification challenge', 'captcha');
      }
      if (href && PAYMENT_HREF.test(safePath(href))) {
        return r('HUMAN_REQUIRED', 'leads to payment', 'payment');
      }
      const isContent = target?.role === 'link' && text.length > CONTENT_LINK_LENGTH;
      if (!isContent) {
        const short = text.slice(0, 40);
        if (PAYMENT.test(text)) return r('HUMAN_REQUIRED', `payment control "${short}"`, 'payment');
        if (DESTRUCTIVE.test(text)) return r('HIGH', `destructive control "${short}"`);
        if (PUBLISH.test(text)) return r('HIGH', `publishing/sending control "${short}"`);
        if (ADD_TO_CART.test(text)) return r('MEDIUM', 'adds to cart');
        if (target?.inputType === 'submit' || target?.attributes['type'] === 'submit') {
          return r('MEDIUM', 'submits a form');
        }
      }
      return r('LOW', target?.role === 'link' ? 'opens a link' : 'click');
    }
  }
}

function isSearchField(node: DOMNode): boolean {
  const text = `${node.name ?? ''} ${node.attributes['placeholder'] ?? ''} ${node.attributes['name'] ?? ''}`;
  return (
    node.role === 'searchbox' || node.inputType === 'search' || /search|query|find/i.test(text)
  );
}

function safeProtocol(url: string): string {
  try {
    return new URL(url).protocol;
  } catch {
    return '';
  }
}

function safePath(url: string): string {
  try {
    return new URL(url, 'https://x.invalid').pathname;
  } catch {
    return '';
  }
}
