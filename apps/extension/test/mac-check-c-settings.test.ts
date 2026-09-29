import { describe, expect, it } from 'vitest';
import { privacyTest } from '../src/settings/diagnostics.js';
import { splitCitySuggestion, splitPhone } from '../src/settings/places.js';

/** Batch C manual check on the Mac (2026-09-29): Settings requests. */
describe('profile helpers', () => {
  it('"Bengaluru, Karnataka" from the suggestions fills city and state', () => {
    expect(splitCitySuggestion('Bengaluru, Karnataka')).toEqual({
      city: 'Bengaluru',
      state: 'Karnataka',
    });
    expect(splitCitySuggestion('Bengal')).toEqual({ city: 'Bengal', state: null });
  });

  it('phone numbers keep a country code, +91 by default', () => {
    expect(splitPhone('+91 98765 43210')).toEqual(['+91', '98765 43210']);
    expect(splitPhone('98765 43210')).toEqual(['+91', '98765 43210']);
    expect(splitPhone('+44 7700 900123')).toEqual(['+44', '7700 900123']);
  });
});

describe('diagnostics', () => {
  it('the privacy test masks all sample personal data', () => {
    const r = privacyTest();
    expect(r.ok, r.detail).toBe(true);
  });
});
