import type { DOMNode, PrivacyKind, UserProfile } from '@techie-mind/contracts';
import { detectField } from '@techie-mind/privacy';

/**
 * Form filling (spec §35, plan §32): map each visible field to a profile value BY MEANING —
 * autocomplete tokens first, then the field's label/placeholder/name. Unknown fields are never
 * filled; passwords, OTPs and card fields are never filled from the profile.
 */

export type FillField =
  | 'fullName'
  | 'firstName'
  | 'lastName'
  | 'email'
  | 'phone'
  | 'addressLine1'
  | 'addressLine2'
  | 'city'
  | 'state'
  | 'postalCode'
  | 'country';

export type FieldPlan =
  | { node: DOMNode; field: FillField; kind: PrivacyKind; value: string }
  | { node: DOMNode; skip: 'secret' | 'unknown' | 'empty-profile-value'; label: string };

const AUTOCOMPLETE: Array<[RegExp, FillField]> = [
  [/\bgiven-name\b/, 'firstName'],
  [/\bfamily-name\b/, 'lastName'],
  [/\bname\b/, 'fullName'],
  [/\bemail\b/, 'email'],
  [/\btel(?:-national)?\b/, 'phone'],
  [/\b(?:street-address|address-line1)\b/, 'addressLine1'],
  [/\baddress-line2\b/, 'addressLine2'],
  [/\baddress-level2\b/, 'city'],
  [/\baddress-level1\b/, 'state'],
  [/\bpostal-code\b/, 'postalCode'],
  [/\bcountry(?:-name)?\b/, 'country'],
];

const LABELS: Array<[RegExp, FillField]> = [
  [/\bfirst\s*name\b|\bgiven\s*name\b/i, 'firstName'],
  [/\blast\s*name\b|\bsurname\b|\bfamily\s*name\b/i, 'lastName'],
  [/\be-?mail\b/i, 'email'],
  [/\b(?:phone|mobile|tel(?:ephone)?|contact\s*number|whatsapp)\b/i, 'phone'],
  [/\b(?:address\s*(?:line)?\s*2|apartment|apt|flat|landmark|suite)\b/i, 'addressLine2'],
  [/\b(?:pin\s*code|pincode|zip|postal)\b/i, 'postalCode'],
  [/\b(?:city|town|district)\b/i, 'city'],
  [/\b(?:state|province|region)\b/i, 'state'],
  [/\bcountry\b/i, 'country'],
  [/\b(?:address|street|house|building)\b/i, 'addressLine1'],
  [/\b(?:full\s*name|your\s*name|name)\b/i, 'fullName'],
];

const KIND: Record<FillField, PrivacyKind> = {
  fullName: 'name',
  firstName: 'name',
  lastName: 'name',
  email: 'email',
  phone: 'phone',
  addressLine1: 'address',
  addressLine2: 'address',
  city: 'address',
  state: 'address',
  postalCode: 'pin_code',
  country: 'address',
};

const NEVER: ReadonlySet<PrivacyKind> = new Set([
  'password',
  'otp',
  'card_number',
  'cvv',
  'upi_id',
  'bank_account',
]);

function valueFor(field: FillField, profile: UserProfile): string {
  const [first = '', ...rest] = profile.fullName.split(/\s+/);
  switch (field) {
    case 'firstName':
      return first;
    case 'lastName':
      return rest.join(' ');
    default:
      return profile[field];
  }
}

function labelOf(node: DOMNode): string {
  return [
    node.name,
    node.attributes['placeholder'],
    node.attributes['name'],
    node.attributes['id'],
    node.attributes['aria-label'],
  ]
    .filter(Boolean)
    .join(' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2') // "userEmail" → "user Email"
    .replace(/[_-]+/g, ' ');
}

/** The field's own type is stronger evidence than any wording near it. */
const BY_INPUT_TYPE: Partial<Record<string, FillField>> = { email: 'email', tel: 'phone' };

/** Which profile value (if any) goes into this field. */
export function planField(node: DOMNode, profile: UserProfile): FieldPlan {
  const label = labelOf(node).slice(0, 80) || node.tag;
  const semantic = detectField(node);
  if (semantic && NEVER.has(semantic.kind)) return { node, skip: 'secret', label };
  const auto = (node.attributes['autocomplete'] ?? '').toLowerCase();
  // Order: autocomplete token, then the input type (type=email is e-mail whatever its placeholder
  // says — live, "name@example.com" made the name planned for an e-mail field), then wording.
  const field =
    AUTOCOMPLETE.find(([re]) => re.test(auto))?.[1] ??
    (node.inputType ? BY_INPUT_TYPE[node.inputType] : undefined) ??
    LABELS.find(([re]) => re.test(labelOf(node)))?.[1] ??
    null;
  if (!field) return { node, skip: 'unknown', label };
  const value = valueFor(field, profile).trim();
  if (!value) return { node, skip: 'empty-profile-value', label };
  return { node, field, kind: KIND[field], value };
}

/** Words in the request that name one profile detail ("fill the phone number", "enter my email"). */
const WANTED: Array<[RegExp, FillField[]]> = [
  [/\b(?:phone|mobile|cell|contact|whatsapp|number)\b/, ['phone']],
  [/\be-?mail\b|\bgmail\b/, ['email']],
  [/\bname\b/, ['fullName', 'firstName', 'lastName']],
  [/\bcity\b|\btown\b/, ['city']],
  [/\bstate\b/, ['state']],
  [/\bzip\b|\bpostal\b/, ['postalCode']],
  [/\bcountry\b/, ['country']],
];

/** Wording that asks for the whole form, not one detail. */
const WHOLE_FORM = /\b(?:form|address|profile|details|everything|all|delivery|shipping)\b/;

/**
 * The profile details the user named, or null when they asked for the whole form. "first name"
 * is not also "name", and "pin number" is a PIN code, not a phone number.
 */
export function requestedFields(text: string): ReadonlySet<FillField> | null {
  const t = text.toLowerCase();
  if (WHOLE_FORM.test(t)) return null;
  const wanted = new Set<FillField>();
  const rest = t
    .replace(/\bfirst\s*name\b/g, () => (wanted.add('firstName'), ' '))
    .replace(/\blast\s*name\b|\bsurname\b/g, () => (wanted.add('lastName'), ' '))
    .replace(/\bpin\s*(?:code|number)?\b|\bpincode\b/g, () => (wanted.add('postalCode'), ' '));
  for (const [re, fields] of WANTED) if (re.test(rest)) fields.forEach((f) => wanted.add(f));
  return wanted.size > 0 ? wanted : null;
}

/** Field wording that shows a field accepts a detail, even when its type says otherwise. */
const MENTIONS: Partial<Record<FillField, RegExp>> = {
  phone: /\b(?:phone|mobile|tel(?:ephone)?|contact\s*number|whatsapp)\b/i,
  email: /\be-?mail\b/i,
  fullName: /\bname\b/i,
  firstName: /\bfirst\s*name\b|\bgiven\s*name\b/i,
  lastName: /\blast\s*name\b|\bsurname\b/i,
  city: /\b(?:city|town)\b/i,
  state: /\b(?:state|province)\b/i,
  postalCode: /\b(?:pin\s*code|pincode|zip|postal)\b/i,
  country: /\bcountry\b/i,
};

/**
 * Only the details the user asked for. A field is used when it was planned for that detail, or
 * when its wording names it — "Mobile number or email" takes the phone number when the user asked
 * for the phone number — or when it is the only field on the page.
 */
export function targetPlans(
  fields: readonly DOMNode[],
  plans: readonly FieldPlan[],
  wanted: ReadonlySet<FillField>,
  profile: UserProfile,
): FieldPlan[] {
  // "name" means the full name, or its first/last parts where the form splits it.
  const nameParts = wanted.has('fullName');
  const out = plans.filter(
    (p) =>
      'field' in p &&
      (wanted.has(p.field) || (nameParts && (p.field === 'firstName' || p.field === 'lastName'))),
  );
  const used = new Set(out.map((p) => p.node.nodeId));
  const secret = (n: DOMNode) => {
    const kind = detectField(n)?.kind;
    return (kind !== undefined && NEVER.has(kind)) || n.inputType === 'password';
  };
  for (const field of wanted) {
    if (nameParts && (field === 'firstName' || field === 'lastName')) continue;
    const covered = out.some(
      (p) =>
        'field' in p &&
        (p.field === field ||
          (field === 'fullName' && (p.field === 'firstName' || p.field === 'lastName'))),
    );
    if (covered) continue;
    const free = fields.filter((n) => !used.has(n.nodeId) && !secret(n));
    const re = MENTIONS[field];
    const node =
      (re ? free.find((n) => re.test(labelOf(n))) : undefined) ??
      (fields.length === 1 ? free[0] : undefined);
    if (!node) continue;
    used.add(node.nodeId);
    const value = valueFor(field, profile).trim();
    out.push(
      value
        ? { node, field, kind: KIND[field], value }
        : { node, skip: 'empty-profile-value', label: labelOf(node).slice(0, 80) || node.tag },
    );
  }
  return out;
}

// Password fields are listed so the user sees them reported as "never filled" (planField skips them).
const FILLABLE_TYPES = new Set([
  null,
  'text',
  'email',
  'tel',
  'search',
  'url',
  'number',
  'password',
]);

/** Visible, editable text fields and selects of the page's forms, top to bottom. */
export function formFields(nodes: readonly DOMNode[]): DOMNode[] {
  return nodes
    .filter(
      (n) =>
        n.visible &&
        (n.editable || (n.tag === 'select' && n.interactive)) &&
        (n.tag === 'textarea' ||
          n.tag === 'select' ||
          (n.tag === 'input' && FILLABLE_TYPES.has(n.inputType))) &&
        n.attributes['tm:form-role'] !== 'search' &&
        n.role !== 'searchbox',
    )
    .sort((a, b) => (a.bbox?.y ?? 0) - (b.bbox?.y ?? 0));
}
