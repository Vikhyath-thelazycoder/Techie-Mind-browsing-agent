/**
 * Element fingerprint used by action binding. Computed from the element's tag, ARIA role and
 * accessible name — the same inputs on the planning side (from the observation) and on the
 * execution side (from the live element) — so the executor can detect that the node behind an
 * element id is no longer the element the action was planned against.
 */
export function elementFingerprint(tag: string, role: string | null, name: string | null): string {
  const input = `${tag.toLowerCase()}|${role ?? ''}|${(name ?? '').trim().toLowerCase().slice(0, 80)}`;
  // FNV-1a 32-bit — tiny, deterministic, not a security hash (identity check only).
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return `fp-${(hash >>> 0).toString(16).padStart(8, '0')}`;
}
