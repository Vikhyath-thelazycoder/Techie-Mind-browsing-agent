import type { BrowserAdapter } from '@techie-mind/browser';
import { resolveActiveModel, type Settings } from '@techie-mind/config';
import { HISTORY_STORAGE_KEY, TaskResult } from '@techie-mind/contracts';
import { useEffect, useState } from 'preact/hooks';

/** Commands for the SIH demo, in the order of the demo script. */
const DEMOS: ReadonlyArray<[string, string]> = [
  ['Play with sound', 'open YouTube and play a Kannada song'],
  ['Shopping with a price limit', 'search laptops under ₹50,000 on Flipkart'],
  ['Pick from results', 'open the cheapest one'],
  ['Payment handover', 'checkout'],
  ['Form from the saved profile', 'fill my delivery address'],
  ['Summarize', 'summarize this page'],
  ['Skill: compare prices', 'compare iPhone 15 prices on Amazon and Flipkart'],
  ['Kannada (voice or typed)', 'ಯುಟ್ಯೂಬ್ ಓಪನ್ ಮಾಡಿ ಕನ್ನಡ ಸಾಂಗ್ಸ್ ಪ್ಲೇ ಮಾಡು'],
  ['Price monitor', 'monitor this product until the price drops below ₹70,000'],
  ['Ask about a file (attach one first)', 'what is this document about?'],
];

/** Measured on the MacBook during the final validation (docs/phases/BATCH_*_MAC_CHECK.md). */
const MAC_VALIDATION: ReadonlyArray<[string, string]> = [
  ['Unit tests', '491+ passing'],
  ['Real-Chrome tests', '58 / 58'],
  ['Live websites', '34 / 35 (Amazon blocks automated browsers)'],
  ['Laya decision (warm)', '≈ 34 ms'],
  ['Translation to English (local Qwen)', '0.5 – 1.8 s'],
  ['Monitoring backend', 'checks every 5 min, 0 failed runs'],
  ['Data sent off the device', '0 bytes of page content'],
];

const median = (xs: number[]) => {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)]!;
};
const p90 = (xs: number[]) => {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(s.length * 0.9))]!;
};
const secs = (ms: number) => (ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`);

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div class="tm-lab-row">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

export function DemoLab({ adapter, settings }: { adapter: BrowserAdapter; settings: Settings }) {
  const [results, setResults] = useState<TaskResult[] | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  useEffect(() => {
    void adapter.storageGet(HISTORY_STORAGE_KEY).then((v) => {
      const list = Array.isArray(v) ? v : [];
      setResults(list.flatMap((r) => TaskResult.safeParse(r).data ?? []));
    });
  }, [adapter]);

  const model = resolveActiveModel(settings);
  const done = results ?? [];
  const n = done.length;
  const count = (s: TaskResult['status']) => done.filter((r) => r.status === s).length;
  const totals = done.map((r) => r.timings.totalMs);
  const avg = (key: keyof TaskResult['timings']) =>
    n ? done.reduce((sum, r) => sum + Number(r.timings[key] ?? 0), 0) / n : 0;
  const stages = (
    [
      ['Page loads & waiting', avg('navigationMs') + avg('waitMs')],
      ['Local models', avg('modelMs') + avg('visionMs')],
      ['Reading pages', avg('observationMs') + avg('groundingMs')],
      ['Privacy scan', avg('privacyMs')],
      ['Firewall checks', avg('firewallMs')],
    ] as Array<[string, number]>
  ).sort((a, b) => b[1] - a[1]);
  const tiers = new Map<string, number>();
  for (const r of done) for (const m of r.models) tiers.set(m.tier, (tiers.get(m.tier) ?? 0) + 1);
  const sum = (f: (r: TaskResult) => number) => done.reduce((s, r) => s + f(r), 0);

  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(text);
      setTimeout(() => setCopied(null), 1500);
    } catch {
      setCopied(null);
    }
  };

  return (
    <div class="tm-lab" data-testid="demo-lab">
      <h3>This setup</h3>
      <Row label="Version" value={`Techie Mind ${adapter.version}`} />
      <Row
        label="Reasoning model"
        value={`${model.label}${model.local ? ' (on this Mac)' : ' (gateway)'}`}
      />
      <Row label="Laya fast decisions" value={settings.model.laya.enabled ? 'On' : 'Off'} />
      <Row
        label="Voice input"
        value={
          settings.voice.inputEnabled
            ? settings.voice.sttEngine === 'local-whisper'
              ? 'On — local Whisper'
              : 'On — Chrome Web Speech'
            : 'Off'
        }
      />
      <Row label="Privacy boundary" value={settings.privacy.enabled ? 'On' : 'Off'} />
      <Row
        label="Mode"
        value={
          settings.agent.autonomy === 'act-without-asking'
            ? 'Act without asking'
            : 'Ask before acting'
        }
      />
      <Row
        label="Monitoring backend"
        value={settings.monitoring.apiUrl ? 'Connected' : 'Not set up'}
      />

      <h3>Benchmark — your tasks in this browser</h3>
      {results === null ? (
        <p class="tm-muted">Loading…</p>
      ) : n === 0 ? (
        <p class="tm-muted">No tasks yet. Run a few (the demo commands below), then come back.</p>
      ) : (
        <>
          <Row label="Tasks" value={String(n)} />
          <Row
            label="Completed · needed you · failed"
            value={`${count('COMPLETED')} · ${count('HUMAN_REQUIRED') + count('PAUSED')} · ${count('FAILED')}`}
          />
          <Row label="Success rate" value={`${Math.round((count('COMPLETED') / n) * 100)}%`} />
          <Row label="Typical task time (median)" value={secs(median(totals))} />
          <Row label="Slow tasks (90th percentile)" value={secs(p90(totals))} />
          {stages.slice(0, 3).map(([label, ms]) => (
            <Row key={label} label={`Avg. ${label.toLowerCase()}`} value={secs(ms)} />
          ))}
          <Row
            label="Model calls"
            value={
              tiers.size === 0
                ? 'none (code only)'
                : [...tiers.entries()].map(([t, c]) => `${t} ${c}`).join(' · ')
            }
          />
          <Row
            label="Pages scanned for privacy"
            value={String(sum((r) => r.privacy?.scans ?? 0))}
          />
          <Row
            label="Sensitive items found (kept local)"
            value={String(sum((r) => r.privacy?.detected ?? 0))}
          />
          <Row
            label="Hidden instructions ignored"
            value={String(sum((r) => r.privacy?.injectionsIgnored ?? 0))}
          />
          <Row
            label="Actions blocked by the firewall"
            value={String(sum((r) => r.privacy?.actionsBlocked ?? 0))}
          />
          <Row
            label="Page content sent off the device"
            value={`${sum((r) => r.privacy?.sentExternally ?? 0)} bytes`}
          />
        </>
      )}

      <h3>Final validation on the Mac (29 Sep 2026)</h3>
      {MAC_VALIDATION.map(([label, value]) => (
        <Row key={label} label={label} value={value} />
      ))}

      <h3>Demo launchers</h3>
      <p class="tm-muted">Copy a command, paste it into the side panel.</p>
      {DEMOS.map(([label, text]) => (
        <div class="tm-lab-row" key={text}>
          <span>
            {label}
            <small class="tm-muted"> — {text}</small>
          </span>
          <button type="button" class="tm-btn-outline" onClick={() => void copy(text)}>
            {copied === text ? 'Copied' : 'Copy'}
          </button>
        </div>
      ))}
    </div>
  );
}
