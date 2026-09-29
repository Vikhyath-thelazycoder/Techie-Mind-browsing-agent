import { EMPTY_PROFILE, type UserProfile } from '@techie-mind/contracts';
import { describe, expect, it } from 'vitest';
import { planField } from '../src/forms.js';
import { node } from './nodes.js';

const PROFILE: UserProfile = {
  ...EMPTY_PROFILE,
  fullName: 'Asha Testuser',
  email: 'asha.testuser@example.com',
  phone: '9000000001',
  addressLine1: '12 Test Street, Sample Nagar',
};

const planned = (n: ReturnType<typeof node>) => {
  const p = planField(n, PROFILE);
  return 'skip' in p ? `skip:${p.skip}` : `${p.field}=${p.value}`;
};

/**
 * Live on the Mac (demoqa.com practice form): the e-mail field has id "userEmail" and placeholder
 * "name@example.com", so the mapper matched the word "name" and planned the NAME for it — the
 * firewall stopped it ("personal data field (email)"). Real attributes of that form below.
 */
describe('form mapping by meaning', () => {
  it('fills a real practice form correctly (camelCase ids, example placeholders)', () => {
    expect(
      planned(
        node({
          tag: 'input',
          inputType: 'email',
          name: 'name@example.com',
          attributes: { id: 'userEmail', placeholder: 'name@example.com' },
        }),
      ),
    ).toBe('email=asha.testuser@example.com');
    expect(
      planned(
        node({
          tag: 'input',
          name: 'First Name',
          attributes: { id: 'firstName', placeholder: 'First Name' },
        }),
      ),
    ).toBe('firstName=Asha');
    expect(
      planned(
        node({
          tag: 'input',
          name: 'Mobile Number',
          attributes: { id: 'userNumber', placeholder: 'Mobile Number' },
        }),
      ),
    ).toBe('phone=9000000001');
    expect(
      planned(
        node({
          tag: 'textarea',
          name: 'Current Address',
          attributes: { id: 'currentAddress', placeholder: 'Current Address' },
        }),
      ),
    ).toBe('addressLine1=12 Test Street, Sample Nagar');
  });

  it('the input type decides for email and phone fields', () => {
    expect(planned(node({ tag: 'input', inputType: 'tel', name: 'Your name here' }))).toBe(
      'phone=9000000001',
    );
  });
});
