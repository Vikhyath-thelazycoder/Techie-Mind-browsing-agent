import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import type { Page } from '@playwright/test';
import type { AgentRun } from '../browser/agent-helpers.js';

/**
 * Live tests run headless, and headless Chromium announces itself as "HeadlessChrome" — some sites
 * (bot protection) reset such connections outright, which a user's normal Chrome never sees. The
 * live browser therefore presents the ordinary desktop Chrome user agent of the same engine
 * version. This changes nothing in the extension; it only makes the test browser look like the
 * browser the extension actually runs in.
 */
export const LIVE_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36';
export const LIVE_BROWSER_ARGS = [`--user-agent=${LIVE_USER_AGENT}`];

/** Visible links whose text contains every query term — checked by Playwright, not by the agent. */
export async function visibleMatchingLinks(page: Page, query: string): Promise<number> {
  const terms = query
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length > 2);
  return page.evaluate((terms) => {
    let count = 0;
    for (const a of Array.from(document.querySelectorAll('a[href]'))) {
      const text = (a.textContent ?? '').toLowerCase();
      const rect = a.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0 && terms.some((t) => text.includes(t))) count += 1;
    }
    return count;
  }, terms);
}

/** Current value of the first visible search-like field on the page. */
export async function searchFieldValue(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    const fields = Array.from(document.querySelectorAll('input')) as HTMLInputElement[];
    const visible = fields.filter((f) => {
      const r = f.getBoundingClientRect();
      return (
        r.width > 0 &&
        r.height > 0 &&
        !['hidden', 'password', 'email', 'checkbox', 'radio'].includes(f.type)
      );
    });
    const ranked = visible.find((f) =>
      /search|q$|query/i.test(
        `${f.name} ${f.type} ${f.placeholder} ${f.getAttribute('aria-label') ?? ''}`,
      ),
    );
    return (ranked ?? visible[0])?.value ?? null;
  });
}

export interface LiveEvidence {
  name: string;
  request: string;
  status: string;
  finalUrl: string | null;
  independent: Record<string, unknown>;
  timings: AgentRun['result']['timings'];
  wallMs: number;
  recovery: string[];
  recordedAt?: string;
}

const FILE = 'evidence/phase1-live.json';

/** Merge by test id so separate runs (acceptance, variations, playback) keep each other's evidence. */
export function record(entry: LiveEvidence, file: string = FILE): void {
  mkdirSync('evidence', { recursive: true });
  let existing: LiveEvidence[] = [];
  if (existsSync(file)) {
    try {
      existing = JSON.parse(readFileSync(file, 'utf8')) as LiveEvidence[];
    } catch {
      existing = [];
    }
  }
  const merged = [
    ...existing.filter((e) => e.name !== entry.name),
    { ...entry, recordedAt: new Date().toISOString() },
  ];
  merged.sort((a, b) => a.name.localeCompare(b.name));
  writeFileSync(file, `${JSON.stringify(merged, null, 2)}\n`);
}
