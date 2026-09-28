import { VaultToken, type PrivacyKind } from '@techie-mind/contracts';

/**
 * Memory-only token vault (spec §16, plan §19). Sensitive values stay here; everything that can
 * leave the browser carries only the token ("PHONE_001"). The browser resolves a token back to its
 * value locally, at execution time (FILL_FIELD(fieldId, PHONE_001)).
 *
 *   - never persisted: no storage API is touched, and the vault refuses to serialize its values
 *   - bounded: TTL per entry and a maximum size
 *   - single-use: resolving consumes the entry unless explicitly peeked
 *   - scoped: tokens mean something only inside the vault (task) that issued them; each vault has an
 *     unguessable id, and a token presented to another vault resolves to nothing
 *   - silent: values are never logged, and error messages never contain them
 */

export const TOKEN_PREFIX: Record<PrivacyKind, string> = {
  password: 'PASSWORD',
  email: 'EMAIL',
  phone: 'PHONE',
  name: 'PERSON',
  address: 'ADDRESS',
  pin_code: 'PIN',
  aadhaar: 'AADHAAR',
  pan: 'PAN',
  voter_id: 'VOTERID',
  passport: 'PASSPORT',
  driving_licence: 'LICENCE',
  gstin: 'GSTIN',
  ifsc: 'IFSC',
  upi_id: 'UPI',
  bank_account: 'ACCOUNT',
  card_number: 'CARD',
  cvv: 'CVV',
  otp: 'OTP',
  api_key: 'APIKEY',
  jwt: 'TOKEN',
  auth_token: 'TOKEN',
  secret: 'SECRET',
  face: 'FACE',
  other: 'PRIVATE',
};

interface Entry {
  kind: PrivacyKind;
  value: string;
  expiresAt: number;
}

export interface VaultOptions {
  ttlMs?: number;
  maxEntries?: number;
  now?: () => number;
}

export class VaultError extends Error {}

export class TokenVault {
  /** Unguessable identity of this vault (one per task). */
  readonly id: string = crypto.randomUUID();
  readonly #entries = new Map<string, Entry>();
  /** kind+value → token, so one value is represented consistently within a vault. */
  readonly #byValue = new Map<string, string>();
  readonly #counters = new Map<string, number>();
  readonly #ttlMs: number;
  readonly #maxEntries: number;
  readonly #now: () => number;
  #purged = false;

  constructor(options: VaultOptions = {}) {
    this.#ttlMs = options.ttlMs ?? 10 * 60_000;
    this.#maxEntries = options.maxEntries ?? 1_000;
    this.#now = options.now ?? Date.now;
  }

  get size(): number {
    this.#expire();
    return this.#entries.size;
  }

  get purged(): boolean {
    return this.#purged;
  }

  /** Store a value and return its token. Same value + kind → same token while it lives. */
  tokenize(kind: PrivacyKind, value: string): VaultToken {
    if (this.#purged) throw new VaultError('vault has been purged');
    this.#expire();
    const key = `${kind}\u0000${value}`;
    const existing = this.#byValue.get(key);
    if (existing && this.#entries.has(existing)) return existing;
    if (this.#entries.size >= this.#maxEntries) throw new VaultError('vault is full');
    const prefix = TOKEN_PREFIX[kind];
    const n = (this.#counters.get(prefix) ?? 0) + 1;
    if (n > 999) throw new VaultError(`too many ${prefix} tokens`);
    this.#counters.set(prefix, n);
    const token = VaultToken.parse(`${prefix}_${String(n).padStart(3, '0')}`);
    this.#entries.set(token, { kind, value, expiresAt: this.#now() + this.#ttlMs });
    this.#byValue.set(key, token);
    return token;
  }

  /** Resolve a token to its value. Consumes the entry (single use) unless `consume: false`. */
  resolve(token: string, options: { consume?: boolean } = {}): string | null {
    this.#expire();
    const entry = this.#entries.get(token);
    if (!entry) return null;
    if (options.consume !== false) this.#delete(token, entry);
    return entry.value;
  }

  kindOf(token: string): PrivacyKind | null {
    this.#expire();
    return this.#entries.get(token)?.kind ?? null;
  }

  has(token: string): boolean {
    this.#expire();
    return this.#entries.has(token);
  }

  /** Drop everything (end of task). The vault cannot issue tokens afterwards. */
  purge(): void {
    this.#entries.clear();
    this.#byValue.clear();
    this.#purged = true;
  }

  /** A vault never serializes its values (JSON.stringify, structured logging, storage). */
  toJSON(): { vault: 'redacted'; entries: number } {
    return { vault: 'redacted', entries: this.#entries.size };
  }

  toString(): string {
    return `[TokenVault ${this.#entries.size} entries]`;
  }

  #delete(token: string, entry: Entry) {
    this.#entries.delete(token);
    this.#byValue.delete(`${entry.kind}\u0000${entry.value}`);
  }

  #expire() {
    const now = this.#now();
    for (const [token, entry] of this.#entries) {
      if (entry.expiresAt <= now) this.#delete(token, entry);
    }
  }
}
