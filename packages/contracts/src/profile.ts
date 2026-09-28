import { z } from 'zod';

/**
 * The user's saved profile for form filling (spec §35, §76). Stored only on this device, encrypted
 * (AES-GCM, non-extractable key); values reach a page only through vault tokens resolved at the
 * last hop, and never reach a model, a log or history.
 */
const field = (max: number) => z.string().trim().max(max);

export const PROFILE_FIELDS = [
  'fullName',
  'email',
  'phone',
  'addressLine1',
  'addressLine2',
  'city',
  'state',
  'postalCode',
  'country',
] as const;
export type ProfileField = (typeof PROFILE_FIELDS)[number];

export const UserProfile = z.strictObject({
  fullName: field(120),
  email: field(254),
  phone: field(32),
  addressLine1: field(200),
  addressLine2: field(200),
  city: field(100),
  state: field(100),
  postalCode: field(16),
  country: field(100),
});
export type UserProfile = z.infer<typeof UserProfile>;

export const EMPTY_PROFILE: UserProfile = {
  fullName: '',
  email: '',
  phone: '',
  addressLine1: '',
  addressLine2: '',
  city: '',
  state: '',
  postalCode: '',
  country: '',
};

/** chrome.storage.local key of the encrypted profile blob ({ iv, data } base64). */
export const PROFILE_STORAGE_KEY = 'techieMind.profile';
