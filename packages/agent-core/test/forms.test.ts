import { EMPTY_PROFILE, type UserProfile } from '@techie-mind/contracts';
import { describe, expect, it } from 'vitest';
import { planField, requestedFields, targetPlans } from '../src/forms.js';
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

/**
 * Live on the Mac (Amazon sign-in, 29 Sep): "fill the phone number" put nothing — the page URL was
 * too long for the observation — and would have put the e-mail into the single field labelled
 * "Enter mobile number or email" (type=email). Only the detail the user names is filled.
 */
describe('fill only what the user asked for', () => {
  const targeted = (text: string, fields: ReturnType<typeof node>[]) => {
    const wanted = requestedFields(text);
    const plans = fields.map((n) => planField(n, PROFILE));
    return (wanted ? targetPlans(fields, plans, wanted, PROFILE) : plans).map((p) =>
      'skip' in p ? `skip:${p.skip}` : `${p.field}=${p.value}`,
    );
  };

  it('reads which details the request names', () => {
    expect([...(requestedFields('fill the phone number') ?? [])]).toEqual(['phone']);
    expect([...(requestedFields('enter my email') ?? [])]).toEqual(['email']);
    expect([...(requestedFields('fill my pin number') ?? [])]).toEqual(['postalCode']);
    expect([...(requestedFields('fill my first name') ?? [])]).toEqual(['firstName']);
    expect(requestedFields('fill my delivery address')).toBeNull();
    expect(requestedFields('fill this form')).toBeNull();
  });

  it('puts the phone number into "Enter mobile number or email" on a sign-in page', () => {
    const field = node({
      tag: 'input',
      inputType: 'email',
      name: 'Enter mobile number or email',
      attributes: { name: 'email', id: 'ap_email' },
    });
    expect(targeted('fill the phone number', [field])).toEqual(['phone=9000000001']);
    expect(targeted('fill my email', [field])).toEqual(['email=asha.testuser@example.com']);
  });

  it('fills only the named detail on a full form', () => {
    const form = [
      node({ tag: 'input', name: 'Full name' }),
      node({ tag: 'input', inputType: 'email', name: 'Email' }),
      node({ tag: 'input', inputType: 'tel', name: 'Mobile' }),
    ];
    expect(targeted('fill my phone number', form)).toEqual(['phone=9000000001']);
    expect(targeted('fill my name and email', form)).toEqual([
      'fullName=Asha Testuser',
      'email=asha.testuser@example.com',
    ]);
    expect(targeted('fill the form', form)).toHaveLength(3);
  });

  it('never uses a password field for a named detail', () => {
    const pw = node({ tag: 'input', inputType: 'password', name: 'Password' });
    expect(targeted('fill my phone number', [pw])).toEqual([]);
  });
});
