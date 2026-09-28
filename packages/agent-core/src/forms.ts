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
    .replace(/[_-]+/g, ' ');
}

/** Which profile value (if any) goes into this field. */
export function planField(node: DOMNode, profile: UserProfile): FieldPlan {
  const label = labelOf(node).slice(0, 80) || node.tag;
  const semantic = detectField(node);
  if (semantic && NEVER.has(semantic.kind)) return { node, skip: 'secret', label };
  const auto = (node.attributes['autocomplete'] ?? '').toLowerCase();
  const field =
    AUTOCOMPLETE.find(([re]) => re.test(auto))?.[1] ??
    LABELS.find(([re]) => re.test(labelOf(node)))?.[1] ??
    null;
  if (!field) return { node, skip: 'unknown', label };
  const value = valueFor(field, profile).trim();
  if (!value) return { node, skip: 'empty-profile-value', label };
  return { node, field, kind: KIND[field], value };
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
