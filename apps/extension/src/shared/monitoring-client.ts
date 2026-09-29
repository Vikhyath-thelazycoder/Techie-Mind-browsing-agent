import type { BrowserAdapter } from '@techie-mind/browser';
import { parseSettings, SETTINGS_STORAGE_KEY, type Settings } from '@techie-mind/config';
import { redactForLog } from '@techie-mind/privacy';
import { loadSealed, saveSealed } from './profile-store.js';

/**
 * Client for the persistent monitoring backend (Supabase; spec §38–43).
 *
 * - The user signs in to THEIR OWN Supabase project with e-mail + password. The password is sent
 *   only to Supabase Auth and never stored; the session tokens are stored encrypted (AES-GCM with a
 *   non-extractable key), like the profile.
 * - Only the project URL and the public anon key are in settings. Server secrets (service role,
 *   Resend key, database password) stay in Supabase.
 * - What leaves the browser for a monitor: the page address without query string, a redacted
 *   label and the condition. No page content, no cookies.
 */

const SESSION_STORAGE_KEY = 'techieMind.monitoringSession';
const SESSION_KEY_ID = 'monitoring-session-v1';

interface Session {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  email: string;
}

export interface BackendMonitor {
  id: string;
  url: string;
  label: string;
  kind: 'price-below' | 'content-changed' | 'available';
  threshold: number | null;
  currency: string | null;
  interval_minutes: number;
  status: 'active' | 'paused' | 'cancelled' | 'error';
  next_run_at: string;
  last_checked_at: string | null;
  last_value: number | null;
  last_available: boolean | null;
  condition_met: boolean | null;
  consecutive_failures: number;
  last_error: string | null;
  created_at: string;
}

export interface NewMonitor {
  url: string;
  label: string;
  kind: BackendMonitor['kind'];
  threshold: number | null;
  currency: 'INR' | 'USD' | 'EUR' | 'GBP' | null;
  intervalMinutes: number;
}

export type MonitorAction = 'pause' | 'resume' | 'cancel' | 'delete' | 'check-now';

export class MonitoringError extends Error {}

function authError(body: unknown, fallback: string): string {
  const b = body as { error_description?: string; msg?: string; message?: string; error?: string };
  return (b?.error_description ?? b?.msg ?? b?.message ?? b?.error ?? fallback).slice(0, 200);
}

export class MonitoringClient {
  constructor(
    private readonly adapter: BrowserAdapter,
    private readonly config: Settings['monitoring'],
  ) {}

  static async load(adapter: BrowserAdapter): Promise<MonitoringClient> {
    const parsed = parseSettings(await adapter.storageGet(SETTINGS_STORAGE_KEY));
    const config = parsed.ok ? parsed.value.monitoring : { apiUrl: null, anonKey: '' };
    return new MonitoringClient(adapter, config);
  }

  /** Project URL and anon key are set. */
  get configured(): boolean {
    return Boolean(this.config.apiUrl && this.config.anonKey);
  }

  #base(): string {
    if (!this.configured) {
      throw new MonitoringError(
        'Monitoring is not set up. Add your Supabase project in Settings → Monitoring.',
      );
    }
    return this.config.apiUrl!.replace(/\/+$/, '');
  }

  async #auth(path: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const res = await fetch(`${this.#base()}/auth/v1/${path}`, {
      method: 'POST',
      headers: { apikey: this.config.anonKey, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) throw new MonitoringError(authError(json, `sign-in failed (HTTP ${res.status})`));
    return json;
  }

  async #store(json: Record<string, unknown>, email: string): Promise<Session> {
    const session: Session = {
      accessToken: String(json['access_token'] ?? ''),
      refreshToken: String(json['refresh_token'] ?? ''),
      expiresAt: Date.now() + Number(json['expires_in'] ?? 3600) * 1000,
      email,
    };
    if (!session.accessToken || !session.refreshToken) {
      throw new MonitoringError(
        'Supabase did not return a session. Confirm your e-mail first, then sign in.',
      );
    }
    await saveSealed(this.adapter, SESSION_STORAGE_KEY, SESSION_KEY_ID, session);
    return session;
  }

  /** Create an account. Supabase sends a confirmation e-mail; sign in after confirming. */
  async signUp(email: string, password: string): Promise<'confirm-email' | 'signed-in'> {
    const json = await this.#auth('signup', { email, password });
    if (json['access_token']) {
      await this.#store(json, email);
      return 'signed-in';
    }
    return 'confirm-email';
  }

  async signIn(email: string, password: string): Promise<void> {
    const json = await this.#auth('token?grant_type=password', { email, password });
    await this.#store(json, email);
  }

  async signOut(): Promise<void> {
    const session = await this.#session(false).catch(() => null);
    if (session && this.configured) {
      await fetch(`${this.#base()}/auth/v1/logout`, {
        method: 'POST',
        headers: { apikey: this.config.anonKey, authorization: `Bearer ${session.accessToken}` },
      }).catch(() => undefined);
    }
    await this.adapter.storageSet(SESSION_STORAGE_KEY, null);
  }

  /** The signed-in e-mail, or null. */
  async who(): Promise<string | null> {
    const session = await this.#session(false).catch(() => null);
    return session?.email ?? null;
  }

  async #session(refresh = true): Promise<Session | null> {
    const stored = (await loadSealed(
      this.adapter,
      SESSION_STORAGE_KEY,
      SESSION_KEY_ID,
    )) as Session | null;
    if (!stored?.accessToken) return null;
    if (!refresh || stored.expiresAt - Date.now() > 60_000) return stored;
    const json = await this.#auth('token?grant_type=refresh_token', {
      refresh_token: stored.refreshToken,
    });
    return this.#store(json, stored.email);
  }

  async #api<T>(method: 'GET' | 'POST', body?: unknown): Promise<T> {
    const session = await this.#session();
    if (!session)
      throw new MonitoringError('Sign in to your monitoring account in Settings → Monitoring.');
    const res = await fetch(`${this.#base()}/functions/v1/monitor-api`, {
      method,
      headers: {
        apikey: this.config.anonKey,
        authorization: `Bearer ${session.accessToken}`,
        'content-type': 'application/json',
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok)
      throw new MonitoringError(authError(json, `monitoring backend error (HTTP ${res.status})`));
    return json as T;
  }

  async list(): Promise<BackendMonitor[]> {
    const { monitors } = await this.#api<{ monitors: BackendMonitor[] }>('GET');
    return monitors ?? [];
  }

  async create(input: NewMonitor): Promise<BackendMonitor> {
    let url: string;
    try {
      const u = new URL(input.url);
      url = `${u.origin}${u.pathname}`;
    } catch {
      throw new MonitoringError('Not a valid page address.');
    }
    const { monitor } = await this.#api<{ monitor: BackendMonitor }>('POST', {
      action: 'create',
      url,
      label: redactForLog(input.label).slice(0, 200),
      kind: input.kind,
      threshold: input.threshold,
      currency: input.currency,
      intervalMinutes: input.intervalMinutes,
    });
    return monitor;
  }

  async control(action: MonitorAction, id: string): Promise<void> {
    await this.#api('POST', { action, id });
  }

  /** One test e-mail to the signed-in account's own address; returns where it went. */
  async sendTestEmail(): Promise<string> {
    const { sentTo } = await this.#api<{ sentTo: string }>('POST', { action: 'test-email' });
    return sentTo;
  }
}
