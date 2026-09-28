import type { AuditEvent, TaskResult } from '@techie-mind/contracts';
import { Icon } from '../ui/icons.js';
import type { PlanPreview, RunState } from './task-client.js';

const EVENT_LABELS: Partial<Record<AuditEvent['type'], string>> = {
  TASK_STARTED: 'Task received',
  INTENT_RESOLVED: 'Intent resolved',
  TARGET_ROUTED: 'Target',
  NAVIGATION_STARTED: 'Direct navigation',
  OBSERVATION_CREATED: 'Page observed',
  TARGET_GROUNDED: 'Target grounded',
  ACTION_PROPOSED: 'Action proposed',
  ACTION_ALLOWED: 'Firewall: allowed',
  ACTION_EXECUTED: 'Action executed',
  ACTION_BLOCKED: 'Firewall: blocked',
  PRIVACY_SCAN_COMPLETED: 'Privacy scan',
  PRIVACY_EVENT: 'Privacy',
  VERIFICATION_COMPLETED: 'Verification',
  HANDOVER_REQUIRED: 'Needs you',
  TASK_COMPLETED: 'Done',
  TASK_FAILED: 'Stopped',
  SYSTEM: 'System',
};

function clock(at: number): string {
  return new Date(at).toLocaleTimeString([], { hour12: false });
}

export function PlanCard(props: { preview: PlanPreview; onRun: () => void; onCancel: () => void }) {
  const { preview } = props;
  return (
    <section class="tm-card tm-plan" data-testid="plan-card">
      <h3>Plan</h3>
      <p class="tm-muted">“{preview.text}”</p>
      {preview.problem ? (
        <p class="tm-plan-problem" role="alert">
          {preview.problem}
        </p>
      ) : (
        <ol class="tm-plan-steps">
          {preview.steps.map((s) => (
            <li key={s}>{s}</li>
          ))}
        </ol>
      )}
      <p class="tm-plan-meta">
        {preview.needsModel
          ? `${preview.intent.language} · code unsure — the local AI decides when you run it`
          : `${preview.intent.intent} · ${preview.intent.language} · deterministic · 0 model calls`}
      </p>
      <div class="tm-plan-actions">
        <button type="button" class="tm-btn-ghost" onClick={props.onCancel}>
          Cancel
        </button>
        <button
          type="button"
          class="tm-btn-primary"
          data-testid="plan-run"
          disabled={preview.problem !== null}
          onClick={props.onRun}
        >
          Run
        </button>
      </div>
    </section>
  );
}

export function Timeline({ events }: { events: AuditEvent[] }) {
  const visible = events.filter((e) => e.type !== 'ACTION_PROPOSED');
  return (
    <ol class="tm-timeline" data-testid="timeline">
      {visible.map((e) => (
        <li key={e.eventId} class={`tm-tl-${e.level}`} data-type={e.type}>
          <time>{clock(e.at)}</time>
          <span class="tm-tl-label">{EVENT_LABELS[e.type] ?? e.type}</span>
          <span class="tm-tl-msg">{e.message}</span>
        </li>
      ))}
    </ol>
  );
}

const STATUS_TEXT: Record<string, string> = {
  COMPLETED: 'Completed',
  FAILED: 'Failed',
  HUMAN_REQUIRED: 'Needs you',
};

/** Privacy status in one line — counts only (spec §56: never reveal the value). */
function describePrivacy(p: NonNullable<TaskResult['privacy']>): string {
  const parts = [
    p.detected > 0
      ? `Privacy: ${p.detected} sensitive item${p.detected === 1 ? '' : 's'} detected, kept on this device`
      : 'Privacy: no sensitive data detected',
    `${p.sentExternally} sent externally`,
  ];
  if (p.injectionsIgnored > 0) parts.push(`${p.injectionsIgnored} page instruction(s) ignored`);
  if (p.actionsBlocked > 0) parts.push(`${p.actionsBlocked} action(s) blocked`);
  return parts.join(' · ');
}

/** One line on WHERE the agent acted and why (navigation policy). */
function describeNavigation(nav: NonNullable<TaskResult['navigation']>): string {
  const chosen = nav.resolution?.chosen?.domain;
  switch (nav.navigationPolicy) {
    case 'REUSE_CURRENT_CONTEXT':
      return `Worked in the current tab — ${nav.reason}`;
    case 'RESOLVE_WEBSITE':
      return chosen
        ? `Found the website for “${nav.resolution?.name}”: ${chosen}${nav.resolution?.fromCache ? ' (remembered)' : ''}`
        : nav.reason;
    case 'SEARCH_AS_LAST_RESORT':
      return `Web search as a last resort — ${nav.reason}`;
    default:
      return `Opened directly — ${nav.reason}`;
  }
}

export function ResultCard({ result }: { result: TaskResult }) {
  const ok = result.status === 'COMPLETED';
  return (
    <section
      class={`tm-card tm-result ${ok ? 'is-ok' : 'is-bad'}`}
      data-testid="result-card"
      data-status={result.status}
    >
      <div class="tm-card-row">
        <strong>{STATUS_TEXT[result.status] ?? result.status}</strong>
        <span class="tm-muted">
          {Math.round(result.timings.totalMs)} ms · {result.timings.modelCalls} model calls
        </span>
      </div>
      {result.navigation ? (
        <p class="tm-muted" data-testid="result-navigation">
          {describeNavigation(result.navigation)}
        </p>
      ) : null}
      {result.privacy ? (
        <p class="tm-muted" data-testid="result-privacy">
          {describePrivacy(result.privacy)}
        </p>
      ) : null}
      <ul class="tm-result-steps">
        {result.steps.map((s, i) => (
          <li key={i}>
            <Icon
              name={s.verified ? 'check' : 'info'}
              size={14}
              class={s.verified ? 'tm-ok-icon' : 'tm-bad-icon'}
            />
            <span>
              <strong>{s.description}</strong>
              <small>{s.evidence}</small>
            </span>
          </li>
        ))}
      </ul>
      {result.output ? <OutputView output={result.output} /> : null}
      {result.error ? <p class="tm-plan-problem">{result.error.message}</p> : null}
    </section>
  );
}

function money(price: number | null, currency: string | null): string {
  if (price === null) return '';
  const symbol =
    currency === 'INR'
      ? '₹'
      : currency === 'USD'
        ? '$'
        : currency === 'EUR'
          ? '€'
          : currency === 'GBP'
            ? '£'
            : '';
  return `${symbol}${price.toLocaleString(currency === 'INR' ? 'en-IN' : 'en-US')}`;
}

/** What the task produced: extracted items, a summary or a list (Phase 5/6). */
function OutputView({ output }: { output: NonNullable<TaskResult['output']> }) {
  return (
    <div class="tm-output" data-testid="result-output" data-kind={output.kind}>
      <strong>{output.title}</strong>
      {output.kind === 'text' ? (
        <>
          <p class="tm-output-text">{output.text}</p>
          <small class="tm-muted">
            {output.source === 'model'
              ? 'Written by your local model from redacted text'
              : 'Taken from the page (no model)'}
          </small>
        </>
      ) : null}
      {output.kind === 'items' ? (
        <ol class="tm-output-items">
          {output.items.map((item, i) => (
            <li key={i}>
              <span>{item.title}</span>
              {item.price !== null ? <b>{money(item.price, item.currency)}</b> : null}
              {item.rating !== null ? <small>★ {item.rating}</small> : null}
            </li>
          ))}
        </ol>
      ) : null}
      {output.kind === 'list' ? (
        <ul class="tm-output-list">
          {output.entries.map((entry, i) => (
            <li key={i}>{entry}</li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

export function RunView(props: { state: RunState; onRun: () => void; onCancel: () => void }) {
  const { state } = props;
  return (
    <section class="tm-run" data-testid="run-view">
      {state.phase === 'preview' && state.preview ? (
        <PlanCard preview={state.preview} onRun={props.onRun} onCancel={props.onCancel} />
      ) : null}
      {state.events.length > 0 ? <Timeline events={state.events} /> : null}
      {state.phase === 'running' ? (
        <p class="tm-muted" role="status">
          Working…
        </p>
      ) : null}
      {state.result ? <ResultCard result={state.result} /> : null}
      {state.error ? (
        <p class="tm-plan-problem" role="alert">
          {state.error}
        </p>
      ) : null}
    </section>
  );
}
