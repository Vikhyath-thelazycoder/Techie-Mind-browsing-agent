/**
 * Accessibility projection (perception level 2). Computes the ARIA role, accessible name and states
 * of an element following WAI-ARIA / HTML-AAM / accname rules (simplified to what grounding needs).
 *
 * Why computed rather than the browser's native AX tree: reading Chrome's tree requires the
 * `debugger` permission (and a visible "being debugged" bar) and has no Firefox equivalent. The
 * computed projection works identically in both browsers without extra permissions.
 */

const INPUT_ROLES: Record<string, string> = {
  search: 'searchbox',
  text: 'textbox',
  email: 'textbox',
  tel: 'textbox',
  url: 'textbox',
  password: 'textbox',
  number: 'spinbutton',
  range: 'slider',
  checkbox: 'checkbox',
  radio: 'radio',
  submit: 'button',
  button: 'button',
  reset: 'button',
  image: 'button',
};

const TAG_ROLES: Record<string, string> = {
  button: 'button',
  textarea: 'textbox',
  summary: 'button',
  nav: 'navigation',
  main: 'main',
  header: 'banner',
  footer: 'contentinfo',
  aside: 'complementary',
  form: 'form',
  search: 'search',
  dialog: 'dialog',
  h1: 'heading',
  h2: 'heading',
  h3: 'heading',
  h4: 'heading',
  h5: 'heading',
  h6: 'heading',
  img: 'img',
  video: 'video',
  audio: 'audio',
  li: 'listitem',
  ul: 'list',
  ol: 'list',
  option: 'option',
};

export function computeRole(el: Element): string | null {
  const explicit = el.getAttribute('role')?.trim().split(/\s+/)[0];
  if (explicit) return explicit.toLowerCase();
  const tag = el.localName;
  if (tag === 'a' || tag === 'area') return el.hasAttribute('href') ? 'link' : null;
  if (tag === 'input') {
    const type = ((el as HTMLInputElement).type || 'text').toLowerCase();
    if (el.hasAttribute('list') && ['text', 'search', 'email', 'tel', 'url'].includes(type)) {
      return 'combobox';
    }
    return INPUT_ROLES[type] ?? 'textbox';
  }
  if (tag === 'select') {
    const s = el as HTMLSelectElement;
    return s.multiple || s.size > 1 ? 'listbox' : 'combobox';
  }
  if ((el as HTMLElement).isContentEditable && el.getAttribute('contenteditable') !== null) {
    return 'textbox';
  }
  return TAG_ROLES[tag] ?? null;
}

function collapse(text: string | null | undefined, max = 200): string {
  return (text ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function textOf(el: Element): string {
  // innerText respects CSS visibility; fall back to textContent where layout is unavailable.
  const inner = (el as HTMLElement).innerText;
  return collapse(typeof inner === 'string' && inner.length > 0 ? inner : el.textContent);
}

/** Accessible name (accname 1.2, simplified: labelledby → aria-label → native label → attributes → content). */
export function computeName(el: Element): string | null {
  const doc = el.ownerDocument;
  const labelledBy = el.getAttribute('aria-labelledby');
  if (labelledBy) {
    const text = labelledBy
      .split(/\s+/)
      .map((id) => doc.getElementById(id))
      .filter((n): n is HTMLElement => n !== null)
      .map((n) => textOf(n))
      .join(' ');
    if (collapse(text)) return collapse(text);
  }
  const ariaLabel = collapse(el.getAttribute('aria-label'));
  if (ariaLabel) return ariaLabel;

  const tag = el.localName;
  if (tag === 'input' || tag === 'textarea' || tag === 'select') {
    const control = el as HTMLInputElement;
    const labels = control.labels
      ? Array.from(control.labels)
          .map((l) => textOf(l))
          .join(' ')
      : '';
    if (collapse(labels)) return collapse(labels);
    const type = (control.type || '').toLowerCase();
    if (['submit', 'button', 'reset'].includes(type) && control.value)
      return collapse(control.value);
    if (type === 'image') return collapse(control.alt || control.value) || null;
    const placeholder = collapse(el.getAttribute('placeholder'));
    if (placeholder) return placeholder;
    return collapse(el.getAttribute('title')) || null;
  }
  if (tag === 'img') return collapse(el.getAttribute('alt') ?? el.getAttribute('title')) || null;

  const role = computeRole(el);
  if (
    role &&
    [
      'button',
      'link',
      'heading',
      'tab',
      'menuitem',
      'option',
      'listitem',
      'checkbox',
      'radio',
    ].includes(role)
  ) {
    const content = textOf(el);
    if (content) return content;
    const img = el.querySelector('img[alt], svg title');
    const alt = img ? collapse(img.getAttribute('alt') ?? img.textContent) : '';
    if (alt) return alt;
  }
  return collapse(el.getAttribute('title')) || null;
}

export function computeStates(el: Element, visible: boolean): string[] {
  const states: string[] = [];
  const html = el as HTMLInputElement;
  if (html.disabled || el.getAttribute('aria-disabled') === 'true') states.push('disabled');
  if (html.readOnly || el.getAttribute('aria-readonly') === 'true') states.push('readonly');
  if (html.required || el.getAttribute('aria-required') === 'true') states.push('required');
  if (html.checked || el.getAttribute('aria-checked') === 'true') states.push('checked');
  const expanded = el.getAttribute('aria-expanded');
  if (expanded === 'true') states.push('expanded');
  if (expanded === 'false') states.push('collapsed');
  if (el.ownerDocument.activeElement === el) states.push('focused');
  if (!visible) states.push('hidden');
  return states;
}

const LANDMARK_ROLES = new Set([
  'banner',
  'navigation',
  'main',
  'search',
  'contentinfo',
  'complementary',
  'dialog',
]);

/** Nearest landmark role of an element (crossing shadow boundaries). */
export function nearestLandmark(el: Element): string | null {
  let node: Element | null = el.parentElement ?? (el.getRootNode() as ShadowRoot).host ?? null;
  while (node) {
    const role = computeRole(node);
    if (role && LANDMARK_ROLES.has(role)) {
      // <header>/<footer> are only banner/contentinfo when not inside article/main/section.
      if (
        (node.localName === 'header' || node.localName === 'footer') &&
        node.closest('article,main,section,aside')
      ) {
        node = node.parentElement;
        continue;
      }
      return role;
    }
    node = node.parentElement ?? (node.getRootNode() as ShadowRoot).host ?? null;
  }
  return null;
}
