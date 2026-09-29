import type { BrowserAdapter } from '@techie-mind/browser';
import { PROFILE_STORAGE_KEY, UserProfile } from '@techie-mind/contracts';

/**
 * The saved profile, encrypted at rest (spec §16, §76). AES-GCM with a NON-EXTRACTABLE key that
 * lives in this extension's own IndexedDB: the key can be used by the extension but never read out,
 * so the ciphertext in chrome.storage is useless on its own (another profile, a sync copy, a copied
 * storage file). Values leave only as vault tokens resolved at the last hop into the page.
 */

const DB = 'techie-mind-keys';
const STORE = 'keys';
const KEY_ID = 'profile-v1';

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB unavailable'));
  });
}

function idb<T>(mode: IDBTransactionMode, run: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const tx = db.transaction(STORE, mode);
        const req = run(tx.objectStore(STORE));
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error ?? new Error('IndexedDB request failed'));
        tx.oncomplete = () => db.close();
      }),
  );
}

async function profileKey(create: boolean): Promise<CryptoKey | null> {
  const existing = await idb<CryptoKey | undefined>('readonly', (s) => s.get(KEY_ID));
  if (existing) return existing;
  if (!create) return null;
  const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, [
    'encrypt',
    'decrypt',
  ]);
  await idb('readwrite', (s) => s.put(key, KEY_ID));
  return key;
}

const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const unb64 = (text: string) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));

interface Sealed {
  v: 1;
  iv: string;
  data: string;
}

export async function saveProfile(adapter: BrowserAdapter, profile: UserProfile): Promise<void> {
  const clean = UserProfile.parse(profile);
  const key = await profileKey(true);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      key!,
      new TextEncoder().encode(JSON.stringify(clean)),
    ),
  );
  const sealed: Sealed = { v: 1, iv: b64(iv), data: b64(data) };
  await adapter.storageSet(PROFILE_STORAGE_KEY, sealed);
}

/** The decrypted profile, or null when none is saved (or it cannot be decrypted here). */
export async function loadProfile(adapter: BrowserAdapter): Promise<UserProfile | null> {
  const sealed = (await adapter.storageGet(PROFILE_STORAGE_KEY)) as Partial<Sealed> | null;
  if (
    !sealed ||
    sealed.v !== 1 ||
    typeof sealed.iv !== 'string' ||
    typeof sealed.data !== 'string'
  ) {
    return null;
  }
  const key = await profileKey(false);
  if (!key) return null;
  try {
    const plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: unb64(sealed.iv) },
      key,
      unb64(sealed.data),
    );
    const parsed = UserProfile.safeParse(JSON.parse(new TextDecoder().decode(plain)));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export async function clearProfile(adapter: BrowserAdapter): Promise<void> {
  await adapter.storageSet(PROFILE_STORAGE_KEY, null);
}

// ── other sealed values (same scheme, separate key per purpose) ────────────────────────────────

async function sealKey(keyId: string, create: boolean): Promise<CryptoKey | null> {
  const existing = await idb<CryptoKey | undefined>('readonly', (s) => s.get(keyId));
  if (existing) return existing;
  if (!create) return null;
  const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, [
    'encrypt',
    'decrypt',
  ]);
  await idb('readwrite', (s) => s.put(key, keyId));
  return key;
}

/** Store a JSON value encrypted with a non-extractable key of its own (e.g. a sign-in session). */
export async function saveSealed(
  adapter: BrowserAdapter,
  storageKey: string,
  keyId: string,
  value: unknown,
): Promise<void> {
  const key = await sealKey(keyId, true);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      key!,
      new TextEncoder().encode(JSON.stringify(value)),
    ),
  );
  const sealed: Sealed = { v: 1, iv: b64(iv), data: b64(data) };
  await adapter.storageSet(storageKey, sealed);
}

export async function loadSealed(
  adapter: BrowserAdapter,
  storageKey: string,
  keyId: string,
): Promise<unknown> {
  const sealed = (await adapter.storageGet(storageKey)) as Partial<Sealed> | null;
  if (!sealed || sealed.v !== 1 || typeof sealed.iv !== 'string' || typeof sealed.data !== 'string')
    return null;
  const key = await sealKey(keyId, false);
  if (!key) return null;
  try {
    const plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: unb64(sealed.iv) },
      key,
      unb64(sealed.data),
    );
    return JSON.parse(new TextDecoder().decode(plain)) as unknown;
  } catch {
    return null;
  }
}
