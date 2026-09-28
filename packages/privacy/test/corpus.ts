import type { PrivacyKind } from '@techie-mind/contracts';
import { gstinCheckChar, verhoeffDigit } from '../src/checksums.js';

/**
 * Labelled evaluation corpus for PII detection (plan §52: precision / recall / F1, false redaction
 * rate). Every value is SYNTHETIC — generated from a seeded PRNG with valid check digits — so no real
 * person's data is ever stored in the repository. Negatives are deliberately look-alikes: order ids,
 * prices, dates, ISBNs, UUIDs, 12-digit numbers with a wrong Verhoeff digit, Luhn-invalid 16-digit
 * numbers, version strings, tracking numbers.
 */

export interface Sample {
  text: string;
  /** Exact sensitive values in `text` with their kind (empty for negatives). */
  spans: Array<{ kind: PrivacyKind; value: string }>;
}

function prng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rand = prng(20260928);
const int = (min: number, max: number) => min + Math.floor(rand() * (max - min + 1));
const digits = (n: number) => Array.from({ length: n }, () => int(0, 9)).join('');
const pick = <T>(items: readonly T[]): T => items[int(0, items.length - 1)]!;
const upper = (n: number) =>
  Array.from({ length: n }, () => String.fromCharCode(65 + int(0, 25))).join('');
const lower = (n: number) =>
  Array.from({ length: n }, () => String.fromCharCode(97 + int(0, 25))).join('');
const alnum = (n: number) => {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  return Array.from({ length: n }, () => chars[int(0, chars.length - 1)]).join('');
};

export function aadhaar(): string {
  const base = `${int(2, 9)}${digits(10)}`;
  return `${base}${verhoeffDigit(base)}`;
}
export function aadhaarInvalid(): string {
  const good = aadhaar();
  const last = (Number(good[11]) + int(1, 9)) % 10;
  return `${good.slice(0, 11)}${last}`;
}

function luhnComplete(prefix: string, length: number): string {
  let body = prefix + digits(length - prefix.length - 1);
  for (let d = 0; d <= 9; d++) {
    const candidate = `${body}${d}`;
    let sum = 0;
    let dbl = false;
    for (let i = candidate.length - 1; i >= 0; i--) {
      let n = Number(candidate[i]);
      if (dbl) {
        n *= 2;
        if (n > 9) n -= 9;
      }
      sum += n;
      dbl = !dbl;
    }
    if (sum % 10 === 0) return candidate;
  }
  body = '';
  return body;
}

export function card(): string {
  const [prefix, len] = pick([
    ['4', 16],
    ['51', 16],
    ['55', 16],
    ['37', 15],
    ['6521', 16],
    ['6011', 16],
  ] as const);
  return luhnComplete(prefix, len);
}
export function cardInvalid(): string {
  const good = card();
  return `${good.slice(0, -1)}${(Number(good.at(-1)) + 5) % 10}`;
}

export function pan(): string {
  return `${upper(3)}${pick(['P', 'C', 'H', 'F', 'T'])}${upper(1)}${digits(4)}${upper(1)}`;
}
export function gstin(): string {
  const first14 = `${String(int(1, 37)).padStart(2, '0')}${pan()}${int(1, 9)}Z`;
  return `${first14}${gstinCheckChar(first14)}`;
}
export const phone = () => `${pick(['6', '7', '8', '9'])}${digits(9)}`;
export const email = () =>
  `${lower(int(4, 9))}.${lower(int(3, 7))}@${pick(['example.com', 'mail.example.org', 'corp.example.in'])}`;
export const upi = () =>
  `${lower(int(4, 9))}${digits(2)}@${pick(['okaxis', 'ybl', 'paytm', 'oksbi', 'ibl'])}`;
export const ifsc = () => `${upper(4)}0${alnum(6).toUpperCase()}`;
export const jwt = () => `eyJ${alnum(20)}.eyJ${alnum(40)}.${alnum(43)}`;
export const apiKey = () =>
  pick([`sk-${alnum(40)}`, `AKIA${upper(16)}`, `ghp_${alnum(36)}`, `AIza${alnum(35)}`]);

const NAMES = [
  'Asha Verma',
  'Rohan Iyer',
  'Kavya Nair',
  'Arjun Mehta',
  'Meera Pillai',
  'Vikram Rao',
  'Sneha Kulkarni',
  'Imran Shaikh',
];
const STREETS = [
  '12 MG Road, Indiranagar, Bengaluru',
  '4/7 Lake View Colony, Pune',
  'Flat 9B, Sea Breeze Towers, Chennai',
];

export function buildCorpus(): Sample[] {
  const out: Sample[] = [];
  const add = (text: string, spans: Sample['spans'] = []) => out.push({ text, spans });
  for (let i = 0; i < 12; i++) {
    const e = email();
    add(`Contact us at ${e} for help.`, [{ kind: 'email', value: e }]);
    const p = phone();
    const phoneText = pick([
      [`Call me on ${p} after 6.`, p],
      [`Mobile: +91 ${p}`, `+91 ${p}`],
      [`WhatsApp ${p.slice(0, 5)} ${p.slice(5)}`, `${p.slice(0, 5)} ${p.slice(5)}`],
    ] as const);
    add(phoneText[0], [{ kind: 'phone', value: phoneText[1] }]);
    const a = aadhaar();
    const spacedAadhaar = `${a.slice(0, 4)} ${a.slice(4, 8)} ${a.slice(8)}`;
    const aadhaarText = pick([
      [`Aadhaar: ${spacedAadhaar}`, spacedAadhaar],
      [`UID ${a} linked`, a],
      [`ID proof ${spacedAadhaar} verified`, spacedAadhaar],
    ] as const);
    add(aadhaarText[0], [{ kind: 'aadhaar', value: aadhaarText[1] }]);
    const pn = pan();
    add(`PAN ${pn} on file`, [{ kind: 'pan', value: pn }]);
    const c = card();
    const spaced = c.length === 16 ? c.replace(/(\d{4})(?=\d)/g, '$1 ') : c;
    add(`Card ${spaced} saved`, [{ kind: 'card_number', value: spaced }]);
    const f = ifsc();
    add(`IFSC code ${f}`, [{ kind: 'ifsc', value: f }]);
    const u = upi();
    add(`Pay via UPI ${u}`, [{ kind: 'upi_id', value: u }]);
    const g = gstin();
    add(`GSTIN: ${g}`, [{ kind: 'gstin', value: g }]);
    const otp = digits(6);
    add(pick([`Your OTP is ${otp}.`, `Use verification code ${otp} to sign in`, `OTP: ${otp}`]), [
      { kind: 'otp', value: otp },
    ]);
    const acct = digits(int(11, 14));
    add(`A/c no ${acct} credited`, [{ kind: 'bank_account', value: acct }]);
    const pin = `${int(1, 9)}${digits(5)}`;
    add(`Pincode ${pin}`, [{ kind: 'pin_code', value: pin }]);
    const j = jwt();
    add(`Authorization token ${j}`, [{ kind: 'jwt', value: j }]);
    const k = apiKey();
    add(`export KEY=${k}`, [{ kind: 'api_key', value: k }]);
    const pw = `${alnum(6)}#${digits(2)}`;
    add(`password: ${pw}`, [{ kind: 'password', value: pw }]);
    const n = pick(NAMES);
    add(`Name: ${n}`, [{ kind: 'name', value: n }]);
    const s = pick(STREETS);
    add(`Address: ${s}\nPhone later`, [{ kind: 'address', value: s }]);
  }
  // Negatives — look-alikes that must NOT be flagged.
  for (let i = 0; i < 12; i++) {
    add(`Order OD${digits(15)} shipped`);
    add(`Price ₹${int(1, 99)},${digits(3)} only`);
    add(`Delivered on ${int(2019, 2026)}-0${int(1, 9)}-1${int(0, 9)}`);
    add(`ISBN 978-${int(0, 9)}-${digits(2)}-${digits(6)}-${int(0, 9)}`);
    add(`Request id ${crypto.randomUUID()}`);
    add(`Reference ${aadhaarInvalid()} is not an ID`);
    add(`Item code ${cardInvalid()} in stock`);
    add(`Version v${int(1, 9)}.${int(0, 20)}.${int(0, 9)} released`);
    add(`Tracking number 1Z${upper(3)}${digits(12)}`);
    add(`Timestamp ${1_700_000_000_000 + int(0, 99_999_999)}`);
    add(`Call center hours 10 to 6, room ${digits(3)}`);
    add(`SKU-${digits(6)} blue cotton shirt size 42`);
    add(`Commit ${Array.from({ length: 40 }, () => '0123456789abcdef'[int(0, 15)]).join('')}`);
    add(`Rated ${int(1, 4)}.${int(0, 9)} out of 5 by ${digits(4)} buyers`);
  }
  return out;
}
