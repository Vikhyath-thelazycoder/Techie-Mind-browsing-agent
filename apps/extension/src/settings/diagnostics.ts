import type { Settings } from '@techie-mind/config';
import { redactText } from '@techie-mind/privacy';

export interface ServiceCheck {
  name: string;
  ok: boolean;
  detail: string;
}

const TIMEOUT_MS = 3_000;
const trim = (url: string) => url.replace(/\/+$/, '');

async function reach(url: string, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(url, { headers, signal: AbortSignal.timeout(TIMEOUT_MS), cache: 'no-store' });
}

function failure(error: unknown): string {
  if (error instanceof DOMException && error.name === 'TimeoutError') return 'no answer in 3 s';
  return 'not reachable — is it running?';
}

/** Reachability of every local and backend service the agent uses. Nothing is sent but a ping. */
export async function checkServices(settings: Settings): Promise<ServiceCheck[]> {
  const checks: Array<Promise<ServiceCheck>> = [];
  const { ollama, laya } = settings.model;

  checks.push(
    (async () => {
      const name = `Ollama (${ollama.model})`;
      try {
        const res = await reach(`${trim(ollama.baseUrl)}/api/tags`);
        const models = ((await res.json()) as { models?: Array<{ name?: string }> }).models ?? [];
        const has = models.some(
          (m) => m.name === ollama.model || m.name === `${ollama.model}:latest`,
        );
        return {
          name,
          ok: has,
          detail: has
            ? `running · ${models.length} model(s) installed`
            : `running, but ${ollama.model} is not installed (ollama pull ${ollama.model})`,
        };
      } catch (e) {
        return { name, ok: false, detail: failure(e) };
      }
    })(),
  );

  if (laya.enabled) {
    checks.push(
      (async () => {
        const name = 'Laya (fast local decisions)';
        try {
          const res = await reach(`${trim(laya.adapterUrl)}/health`);
          return { name, ok: res.ok, detail: res.ok ? 'running' : `answered HTTP ${res.status}` };
        } catch (e) {
          return { name, ok: false, detail: failure(e) };
        }
      })(),
    );
  }

  if (settings.voice.sttEngine === 'local-whisper') {
    checks.push(
      (async () => {
        const name = 'Voice (local Whisper)';
        try {
          await reach(new URL(settings.voice.localSttUrl).origin);
          return { name, ok: true, detail: 'running' };
        } catch (e) {
          return { name, ok: false, detail: failure(e) };
        }
      })(),
    );
  }

  const { apiUrl, anonKey } = settings.monitoring;
  if (apiUrl && anonKey) {
    checks.push(
      (async () => {
        const name = 'Monitoring backend (Supabase)';
        try {
          const res = await reach(`${trim(apiUrl)}/auth/v1/health`, { apikey: anonKey });
          return {
            name,
            ok: res.ok,
            detail: res.ok ? 'online' : `answered HTTP ${res.status} (project paused?)`,
          };
        } catch (e) {
          return { name, ok: false, detail: failure(e) };
        }
      })(),
    );
  }

  return Promise.all(checks);
}

/** Made-up personal data that the privacy engine must mask completely. */
const PRIVACY_SAMPLE = {
  phone: '9876543210',
  email: 'asha.testuser@example.com',
  pan: 'ABCPE1234F',
  card: '4111 1111 1111 1111',
};

/** Run the real redaction engine on sample data; pass only when nothing raw survives. */
export function privacyTest(): ServiceCheck {
  const text = `Call Asha on ${PRIVACY_SAMPLE.phone}, mail ${PRIVACY_SAMPLE.email}, PAN ${PRIVACY_SAMPLE.pan}, card ${PRIVACY_SAMPLE.card}.`;
  const { text: out, detections } = redactText(text);
  const leaked = Object.entries(PRIVACY_SAMPLE).filter(([, v]) => out.includes(v));
  return {
    name: 'Privacy engine',
    ok: leaked.length === 0,
    detail:
      leaked.length === 0
        ? `phone, e-mail, PAN and card number all masked (${detections.length} detections)`
        : `NOT masked: ${leaked.map(([k]) => k).join(', ')}`,
  };
}
