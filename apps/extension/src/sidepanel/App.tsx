import type { BrowserAdapter } from '@techie-mind/browser';
import { PRODUCT_NAME, resolveActiveModel, type Settings } from '@techie-mind/config';
import {
  FileAttachment,
  MAX_ANALYSIS_BYTES,
  MAX_ATTACHMENT_BYTES,
  OpenSettingsRequest,
  type FileDigest,
  type CustomSkill,
  HISTORY_STORAGE_KEY,
  TaskResult,
  type TaskMode,
} from '@techie-mind/contracts';
import { useEffect, useRef, useState } from 'preact/hooks';
import { loadSkills } from '../shared/skills-store.js';
import { Icon, LogoMark, type IconName } from '../ui/icons.js';
import { saveSettings, useSettings } from '../ui/settings-store.js';
import { RunView } from './activity.js';
import { buildDigest, isAnalyzable } from './file-digest.js';
import { HistoryView } from './history.js';
import { skillMenuItems } from './skill-menu.js';
import { useTaskRunner } from './task-client.js';
import { speakResult, useVoiceInput, VOICE_LANGUAGES } from './voice.js';

type View = 'agent' | 'history' | 'privacy';

const VIEWS: ReadonlyArray<{ id: View; label: string; icon: IconName }> = [
  { id: 'agent', label: 'Agent', icon: 'agent' },
  { id: 'history', label: 'History', icon: 'clock' },
  { id: 'privacy', label: 'Privacy', icon: 'shield' },
];

export function App({ adapter }: { adapter: BrowserAdapter }) {
  const { settings, loadError } = useSettings(adapter);
  const [view, setView] = useState<View>('agent');
  const [draft, setDraft] = useState('');
  const [mode, setMode] = useState<TaskMode>('search');
  const runner = useTaskRunner(adapter);

  /** Ask before acting → show the plan first; act without asking → run immediately. */
  // Spoken replies (Settings → Voice): say each task's outcome once, when it arrives.
  const spoken = useRef<string | null>(null);
  useEffect(() => {
    const result = runner.state.result;
    if (!result || !settings.voice.ttsEnabled || spoken.current === result.taskId) return;
    spoken.current = result.taskId;
    speakResult(result, settings.voice.voicePersona);
  }, [runner.state.result, settings.voice.ttsEnabled, settings.voice.voicePersona]);

  // The file attached with the paperclip: "upload it" puts it into the page (≤ 25 MB); any other
  // request is a question about it, answered by the local model (≤ 50 MB). Memory only.
  const [attachment, setAttachment] = useState<FileAttachment | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const pendingDigest = useRef<FileDigest | null>(null);
  const attach = (next: FileAttachment | null, picked: File | null) => {
    setAttachment(next);
    setFile(picked);
    setFileError(null);
  };
  /** A question about the attached file: read it here; only its text/images go to the local model. */
  const digestFor = async (text: string): Promise<FileDigest | null> => {
    if (!file || /^\s*(?:upload|attach)\b/i.test(text) || !isAnalyzable(file)) return null;
    try {
      return await buildDigest(file);
    } catch {
      setFileError(`Could not read "${file.name}". Is it a valid PDF, image or text file?`);
      return null;
    }
  };
  // The latest task in history, for the privacy inspector when nothing ran in this panel yet.
  const [lastResult, setLastResult] = useState<TaskResult | null>(null);
  useEffect(() => {
    if (view !== 'privacy') return;
    void adapter
      .storageGet(HISTORY_STORAGE_KEY)
      .then((v) =>
        setLastResult(Array.isArray(v) ? (TaskResult.safeParse(v[0]).data ?? null) : null),
      );
  }, [view, adapter]);

  const submit = async (text: string, source: 'typed' | 'rerun' | 'voice' = 'typed') => {
    const trimmed = text.trim();
    if (!trimmed || runner.state.phase === 'running') return;
    setView('agent');
    setDraft('');
    const digest = await digestFor(trimmed);
    pendingDigest.current = digest;
    if (settings.agent.autonomy === 'ask-before-acting') runner.preview(trimmed);
    else runner.run(trimmed, mode, source, attachment, digest);
  };

  const openSettings = () => {
    void adapter.sendMessage(OpenSettingsRequest.parse({ type: 'OPEN_SETTINGS' }));
  };

  return (
    <div class="tm-shell">
      <header class="tm-header">
        <div class="tm-brand">
          <LogoMark size={28} />
          <span class="tm-brand-name">{PRODUCT_NAME}</span>
        </div>
        <nav class="tm-tabs" aria-label="Sections">
          {VIEWS.map((v) => (
            <button
              key={v.id}
              type="button"
              class={`tm-tab${view === v.id ? ' is-active' : ''}`}
              aria-pressed={view === v.id}
              data-testid={`tab-${v.id}`}
              onClick={() => setView(v.id)}
            >
              <Icon name={v.icon} size={14} />
              {v.label}
            </button>
          ))}
        </nav>
        <div class="tm-header-actions">
          <button
            type="button"
            class="tm-btn-primary"
            data-testid="new-task"
            onClick={() => {
              setDraft('');
              setAttachment(null);
              runner.reset();
              setView('agent');
            }}
          >
            <Icon name="plus" size={14} /> New
          </button>
          <button
            type="button"
            class="tm-btn-primary"
            title="Open Techie Mind in a full tab"
            onClick={() => void adapter.openTab(adapter.getURL('sidepanel/index.html'))}
          >
            <Icon name="external" size={14} /> Tab
          </button>
        </div>
      </header>

      <div class="tm-statusbar">
        <ModelChip adapter={adapter} settings={settings} />
        <div class="tm-status-right">
          <button
            type="button"
            class="tm-pill"
            data-testid="privacy-pill"
            onClick={() => setView('privacy')}
          >
            <Icon name="shield" size={14} class="tm-accent-icon" />
            Privacy
            <span class={`tm-badge ${settings.privacy.enabled ? 'is-on' : 'is-off'}`}>
              {settings.privacy.enabled ? 'ON' : 'OFF'}
            </span>
          </button>
          <button type="button" class="tm-pill" data-testid="open-settings" onClick={openSettings}>
            <Icon name="gear" size={14} /> Settings
          </button>
        </div>
      </div>

      {loadError ? (
        <p class="tm-banner" role="alert">
          {loadError}
        </p>
      ) : null}

      <main class="tm-main">
        {view === 'agent' && runner.state.phase === 'idle' ? (
          <AgentView
            onOpenSettings={openSettings}
            onRun={(text) => void submit(text)}
            onPrefill={(text) => {
              setDraft(text);
              document.getElementById('tm-task-input')?.focus();
            }}
          />
        ) : null}
        {view === 'agent' && runner.state.phase !== 'idle' ? (
          <RunView
            state={runner.state}
            onRun={() =>
              runner.run(runner.state.text, mode, 'typed', attachment, pendingDigest.current)
            }
            onCancel={runner.reset}
            onControl={runner.control}
            onResume={runner.resume}
          />
        ) : null}
        {view === 'history' ? (
          <HistoryView adapter={adapter} onRerun={(text) => void submit(text, 'rerun')} />
        ) : null}
        {view === 'privacy' ? (
          <PrivacyView settings={settings} result={runner.state.result ?? lastResult} />
        ) : null}
      </main>

      {view === 'agent' ? (
        <Composer
          adapter={adapter}
          settings={settings}
          draft={draft}
          onDraft={setDraft}
          mode={mode}
          onMode={setMode}
          running={runner.state.phase === 'running'}
          onSubmit={() => void submit(draft)}
          onVoice={(text) => void submit(text, 'voice')}
          attachment={attachment}
          file={file}
          onAttachment={attach}
          fileError={fileError}
          onFileError={setFileError}
        />
      ) : null}
    </div>
  );
}

function ModelChip({ adapter, settings }: { adapter: BrowserAdapter; settings: Settings }) {
  const [open, setOpen] = useState(false);
  const active = resolveActiveModel(settings);
  const { ollama, openaiCompatible: gateway } = settings.model;
  const gatewayReady = gateway.endpoint !== null && gateway.model.length > 0;

  const choose = async (provider: 'ollama' | 'openai-compatible') => {
    setOpen(false);
    await saveSettings(adapter, settings, { model: { activeProvider: provider } });
  };

  return (
    <div class="tm-popover-anchor">
      <button
        type="button"
        class="tm-pill"
        data-testid="model-chip"
        aria-expanded={open}
        title="Availability is checked each time a task needs the model"
        onClick={() => setOpen(!open)}
      >
        <span
          class={`tm-dot ${active.configured ? 'is-idle' : 'is-error'}`}
          aria-label={active.configured ? 'availability not checked' : 'model not configured'}
        />
        {active.label}
        <Icon name="chevronDown" size={14} />
      </button>
      {open ? (
        <div class="tm-popover" role="menu">
          <button
            type="button"
            role="menuitemradio"
            aria-checked={active.provider === 'ollama'}
            class={`tm-menu-item${active.provider === 'ollama' ? ' is-selected' : ''}`}
            onClick={() => void choose('ollama')}
          >
            <span>
              <strong>Local Model</strong>
              <small>Ollama ({ollama.model || 'not set'})</small>
            </span>
            {active.provider === 'ollama' ? <Icon name="check" size={14} /> : null}
          </button>
          <button
            type="button"
            role="menuitemradio"
            aria-checked={active.provider === 'openai-compatible'}
            disabled={!gatewayReady}
            class={`tm-menu-item${active.provider === 'openai-compatible' ? ' is-selected' : ''}`}
            onClick={() => void choose('openai-compatible')}
          >
            <span>
              <strong>Compatible gateway</strong>
              <small>{gatewayReady ? gateway.model : 'Not configured — add it in Settings'}</small>
            </span>
            {active.provider === 'openai-compatible' ? <Icon name="check" size={14} /> : null}
          </button>
        </div>
      ) : null}
    </div>
  );
}

/** Home tiles: `run` starts the request at once, `prefill` puts it in the box to finish typing. */
const QUICK_ACTIONS: ReadonlyArray<{
  id: string;
  title: string;
  subtitle: string;
  icon: IconName;
  run?: string;
  prefill?: string;
  notice?: string;
  tone?: 'success';
}> = [
  {
    id: 'summaries',
    title: 'Summaries',
    subtitle: 'Key points of this page',
    icon: 'fileText',
    run: 'summarize this page',
  },
  {
    id: 'extract',
    title: 'Extract Data',
    subtitle: 'Page → JSON · CSV',
    icon: 'layout',
    run: 'extract the data as csv',
  },
  {
    id: 'research',
    title: 'Deep Research',
    subtitle: 'Multi-source report',
    icon: 'search',
    prefill: 'research ',
  },
  {
    id: 'private',
    title: 'Private Run',
    subtitle: 'On-device, no cloud',
    icon: 'shieldCheck',
    notice:
      'Every task is private by default: pages are read and redacted on this device, and only your local models (Laya, Ollama) are used unless you add a cloud API in Settings.',
    tone: 'success',
  },
];

function AgentView({
  onOpenSettings,
  onRun,
  onPrefill,
}: {
  onOpenSettings: () => void;
  onRun: (text: string) => void;
  onPrefill: (text: string) => void;
}) {
  const [notice, setNotice] = useState<string | null>(null);
  return (
    <section class="tm-agent" data-testid="agent-view">
      <div class="tm-hero">
        <div class="tm-hero-logo">
          <LogoMark size={52} />
        </div>
        <h1>What are we doing today?</h1>
        <p>Describe a task — I'll browse, research, scrape, or automate it for you.</p>
      </div>
      <div class="tm-cards">
        {QUICK_ACTIONS.map((a) => (
          <button
            key={a.id}
            type="button"
            class="tm-action-card"
            data-testid={`quick-${a.id}`}
            onClick={() => {
              if (a.run) onRun(a.run);
              else if (a.prefill) onPrefill(a.prefill);
              else setNotice(a.notice ?? null);
            }}
          >
            <span class={`tm-action-icon${a.tone === 'success' ? ' is-success' : ''}`}>
              <Icon name={a.icon} size={22} />
            </span>
            <span class="tm-action-text">
              <strong>{a.title}</strong>
              <small>{a.subtitle}</small>
            </span>
            <Icon name="arrowRight" size={16} class="tm-action-arrow" />
          </button>
        ))}
        <button type="button" class="tm-action-card" onClick={onOpenSettings}>
          <span class="tm-action-icon">
            <Icon name="gear" size={22} />
          </span>
          <span class="tm-action-text">
            <strong>Settings &amp; AI Models</strong>
            <small>Configure Ollama, API keys, privacy &amp; skills</small>
          </span>
          <Icon name="arrowUpRight" size={16} class="tm-action-arrow" />
        </button>
      </div>
      {notice ? (
        <p class="tm-notice" role="status" data-testid="agent-notice">
          {notice}
        </p>
      ) : null}
    </section>
  );
}

const DETECTORS = ['PII', 'Secrets', 'Passwords', 'Financial data', 'Faces'];

/**
 * What the last task did with data (spec §56: counts and kinds, never values): what was read, what
 * was found and kept on this device, what the firewall blocked, and exactly what left the browser.
 */
function PrivacyInspector({ result }: { result: TaskResult | null }) {
  if (!result) {
    return (
      <div class="tm-card" data-testid="privacy-inspector">
        <h3>Privacy inspector</h3>
        <p class="tm-muted">
          No task yet. After a task runs, this shows what was read, what was found and kept on this
          device, and exactly what was sent anywhere.
        </p>
      </div>
    );
  }
  const p = result.privacy;
  const kinds = p
    ? Object.entries(p.byKind)
        .filter(([, n]) => n > 0)
        .map(([k, n]) => `${k.replace(/_/g, ' ')} ×${n}`)
        .join(', ')
    : '';
  const called = result.models.filter((m) => m.reason !== 'disabled');
  const local = called.filter((m) => m.tier !== 'api');
  const remote = called.filter((m) => m.tier === 'api');
  const vision = called.some((m) => m.tier === 'vision');
  const rows: Array<[string, string]> = [
    [
      'Pages read',
      `${result.timings.observations} observation(s), ${p?.scans ?? 0} privacy scan(s)`,
    ],
    [
      'Sensitive data found',
      p && p.detected > 0 ? `${p.detected} item(s) — ${kinds}; kept on this device` : 'none',
    ],
    [
      'Page text aimed at the agent',
      p?.injectionsIgnored ? `${p.injectionsIgnored} ignored` : 'none',
    ],
    ['Actions blocked by the firewall', String(p?.actionsBlocked ?? 0)],
    [
      'Local models asked',
      local.length
        ? `${local.map((m) => m.modelId).join(', ')} — only redacted text${vision ? ' and a redacted screenshot' : ''}`
        : 'none (code handled it)',
    ],
    [
      'Sent off this device',
      remote.length
        ? `${remote.length} request(s) to your cloud API — redacted, vault tokens instead of values`
        : `${p?.sentExternally ?? 0} bytes of page content`,
    ],
  ];
  return (
    <div class="tm-card" data-testid="privacy-inspector">
      <h3>Privacy inspector</h3>
      <p class="tm-muted">Last task: “{result.text.slice(0, 120)}”</p>
      <ul class="tm-inspector">
        {rows.map(([label, value]) => (
          <li key={label}>
            <span>{label}</span>
            <span>{value}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function PrivacyView({ settings, result }: { settings: Settings; result: TaskResult | null }) {
  const on = settings.privacy.enabled;
  return (
    <section class="tm-page" data-testid="privacy-view">
      <div class="tm-page-head">
        <h2>Privacy</h2>
      </div>
      <div class="tm-card">
        <div class="tm-card-row">
          <span>Privacy boundary</span>
          <span class={`tm-badge ${on ? 'is-on' : 'is-off'}`}>{on ? 'ON' : 'OFF'}</span>
        </div>
        <div class="tm-card-row">
          <span>Local detection engine</span>
          <span class="tm-tag">{on ? 'Active' : 'Paused'}</span>
        </div>
        <ul class="tm-detector-list">
          {DETECTORS.map((d) => (
            <li key={d}>
              <span>{d}</span>
              <small>
                {on
                  ? 'detected and redacted on this device before anything is sent'
                  : 'off — turn the privacy boundary on in Settings'}
              </small>
            </li>
          ))}
        </ul>
      </div>
      <PrivacyInspector result={result} />
    </section>
  );
}

const MODES: ReadonlyArray<{ id: TaskMode; label: string; icon: IconName }> = [
  { id: 'search', label: 'Search', icon: 'message' },
  { id: 'deep-search', label: 'Deep Search', icon: 'search' },
  { id: 'scrape', label: 'Scrape', icon: 'scrape' },
];

function Composer(props: {
  adapter: BrowserAdapter;
  settings: Settings;
  draft: string;
  onDraft: (v: string) => void;
  mode: TaskMode;
  onMode: (mode: TaskMode) => void;
  running: boolean;
  onSubmit: () => void;
  onVoice: (text: string) => void;
  attachment: FileAttachment | null;
  file: File | null;
  onAttachment: (attachment: FileAttachment | null, file: File | null) => void;
  fileError: string | null;
  onFileError: (error: string | null) => void;
}) {
  const { mode, fileError } = props;
  const fileInput = useRef<HTMLInputElement | null>(null);
  const pickFile = async (file: File | undefined) => {
    props.onFileError(null);
    if (!file) return;
    const mb = (n: number) => Math.round(n / (1024 * 1024));
    if (file.size > MAX_ANALYSIS_BYTES) {
      props.onAttachment(null, null);
      props.onFileError(
        `"${file.name}" is ${mb(file.size)} MB — larger than ${mb(MAX_ANALYSIS_BYTES)} MB, so it was not attached.`,
      );
      return;
    }
    // Up to 25 MB it can also be put into a page ("upload it"); bigger files are for questions only.
    let attachment: FileAttachment | null = null;
    if (file.size <= MAX_ATTACHMENT_BYTES) {
      const bytes = new Uint8Array(await file.arrayBuffer());
      let binary = '';
      for (let i = 0; i < bytes.length; i += 0x8000) {
        binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      }
      attachment = FileAttachment.parse({
        name: file.name.slice(0, 255),
        mime: file.type.slice(0, 128),
        size: file.size,
        base64: btoa(binary),
      });
    }
    props.onAttachment(attachment, file);
  };
  const voice = useVoiceInput(props.settings, props.onVoice);
  const language =
    VOICE_LANGUAGES.find((l) => l.id === props.settings.language.preferredInputLanguage) ??
    VOICE_LANGUAGES[0]!;
  const nextLanguage = async () => {
    const i = VOICE_LANGUAGES.findIndex((l) => l.id === language.id);
    const next = VOICE_LANGUAGES[(i + 1) % VOICE_LANGUAGES.length]!;
    await saveSettings(props.adapter, props.settings, {
      language: { preferredInputLanguage: next.id },
    });
  };
  const toggleSpeech = async () => {
    const on = !props.settings.voice.ttsEnabled;
    if (!on) globalThis.speechSynthesis?.cancel();
    await saveSettings(props.adapter, props.settings, { voice: { ttsEnabled: on } });
  };
  const [menu, setMenu] = useState<'mode' | 'autonomy' | null>(null);
  const autonomy = props.settings.agent.autonomy;
  // "/" opens the skill menu: built-in skills and the user's own (Settings → Skills).
  const [custom, setCustom] = useState<readonly CustomSkill[]>([]);
  const [slashIndex, setSlashIndex] = useState(0);
  const slash = /^\/(\S*)$/u.exec(props.draft);
  useEffect(() => {
    if (slash) void loadSkills(props.adapter).then((s) => setCustom(s.custom));
  }, [props.adapter, slash !== null]);
  const slashItems = slash ? skillMenuItems(slash[1] ?? '', custom) : [];
  const pickSkill = (insert: string) => {
    props.onDraft(insert);
    setSlashIndex(0);
    document.getElementById('tm-task-input')?.focus();
  };
  const currentMode = MODES.find((m) => m.id === mode) ?? MODES[0]!;

  const setAutonomy = async (value: typeof autonomy) => {
    setMenu(null);
    await saveSettings(props.adapter, props.settings, { agent: { autonomy: value } });
  };

  return (
    <footer class="tm-composer">
      <div class="tm-popover-anchor">
        <button
          type="button"
          class="tm-chip"
          aria-expanded={menu === 'mode'}
          title="Switch task mode"
          onClick={() => setMenu(menu === 'mode' ? null : 'mode')}
        >
          <Icon name={currentMode.icon} size={14} /> {currentMode.label}{' '}
          <Icon name="chevronDown" size={14} />
        </button>
        {menu === 'mode' ? (
          <div class="tm-popover" role="menu">
            {MODES.map((m) => (
              <button
                key={m.id}
                type="button"
                role="menuitemradio"
                aria-checked={m.id === mode}
                class={`tm-menu-item${m.id === mode ? ' is-selected' : ''}`}
                onClick={() => {
                  props.onMode(m.id);
                  setMenu(null);
                }}
              >
                <span class="tm-menu-inline">
                  <Icon name={m.icon} size={14} /> {m.label}
                </span>
              </button>
            ))}
          </div>
        ) : null}
      </div>

      <label class="tm-sr-only" for="tm-task-input">
        Task
      </label>
      <div class="tm-popover-anchor tm-input-wrap">
        {slashItems.length > 0 ? (
          <div class="tm-slash-menu" role="listbox" data-testid="slash-menu">
            {slashItems.map((item, i) => (
              <button
                key={item.id}
                type="button"
                role="option"
                aria-selected={i === slashIndex}
                class={`tm-menu-item${i === slashIndex ? ' is-active' : ''}`}
                onMouseDown={(e) => {
                  e.preventDefault();
                  pickSkill(item.insert);
                }}
              >
                <span>
                  <strong>{item.name}</strong>
                  <small>{item.insert.trim() || item.description}</small>
                </span>
              </button>
            ))}
          </div>
        ) : null}
        <textarea
          id="tm-task-input"
          class="tm-input"
          rows={2}
          placeholder="Ask anything — type / for skills"
          value={props.draft}
          data-testid="task-input"
          onInput={(e) => {
            props.onDraft((e.target as HTMLTextAreaElement).value);
            setSlashIndex(0);
          }}
          onKeyDown={(e) => {
            if (slashItems.length > 0) {
              if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                e.preventDefault();
                const step = e.key === 'ArrowDown' ? 1 : -1;
                setSlashIndex((slashIndex + step + slashItems.length) % slashItems.length);
                return;
              }
              if (e.key === 'Enter' || e.key === 'Tab') {
                e.preventDefault();
                pickSkill(slashItems[Math.min(slashIndex, slashItems.length - 1)]!.insert);
                return;
              }
              if (e.key === 'Escape') {
                e.preventDefault();
                props.onDraft('');
                return;
              }
            }
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              props.onSubmit();
            }
          }}
        />
      </div>

      {fileError ? (
        <p class="tm-notice tm-file-error" role="alert" data-testid="attachment-error">
          <span aria-hidden="true">✕</span> {fileError}{' '}
          <button type="button" class="tm-link" onClick={() => props.onFileError(null)}>
            Dismiss
          </button>
        </p>
      ) : props.file ? (
        <p class="tm-notice" role="status" data-testid="attachment-chip">
          📎 {props.file.name} (
          {props.file.size >= 1024 * 1024
            ? `${(props.file.size / (1024 * 1024)).toFixed(1)} MB`
            : `${Math.max(1, Math.round(props.file.size / 1024))} KB`}
          ) — ask about it{props.attachment ? ', or say "upload it" on a page' : ''}.{' '}
          <button type="button" class="tm-link" onClick={() => props.onAttachment(null, null)}>
            Remove
          </button>
        </p>
      ) : null}
      {voice.error ? (
        <p class="tm-notice" role="alert" data-testid="voice-error">
          {voice.error}
        </p>
      ) : voice.phase !== 'idle' ? (
        <p class="tm-notice" role="status" data-testid="voice-status">
          {voice.phase === 'listening'
            ? `Listening (${language.bcp47})… press the mic again when you finish.`
            : 'Recognizing what you said…'}
        </p>
      ) : null}
      <div class="tm-composer-bar">
        <div class="tm-popover-anchor">
          <button
            type="button"
            class="tm-chip"
            data-testid="autonomy"
            aria-expanded={menu === 'autonomy'}
            onClick={() => setMenu(menu === 'autonomy' ? null : 'autonomy')}
          >
            <Icon name="bolt" size={14} class="tm-warn-icon" />
            <span class="tm-chip-label">
              {autonomy === 'act-without-asking' ? 'Act without asking' : 'Ask before acting'}
            </span>
            <Icon name="chevronUp" size={14} />
          </button>
          {menu === 'autonomy' ? (
            <div class="tm-popover is-up" role="menu">
              <button
                type="button"
                role="menuitemradio"
                aria-checked={autonomy === 'ask-before-acting'}
                class={`tm-menu-item${autonomy === 'ask-before-acting' ? ' is-selected' : ''}`}
                onClick={() => void setAutonomy('ask-before-acting')}
              >
                <span>
                  <strong>Ask before acting</strong>
                  <small>Review the plan before execution</small>
                </span>
              </button>
              <button
                type="button"
                role="menuitemradio"
                aria-checked={autonomy === 'act-without-asking'}
                class={`tm-menu-item${autonomy === 'act-without-asking' ? ' is-selected' : ''}`}
                onClick={() => void setAutonomy('act-without-asking')}
              >
                <span>
                  <strong>Act without asking</strong>
                  <small>Run immediately; payments, OTP and CAPTCHA still hand over to you</small>
                </span>
              </button>
            </div>
          ) : null}
        </div>
        <div class="tm-composer-tools">
          <input
            ref={fileInput}
            type="file"
            hidden
            data-testid="attach-input"
            onChange={(e) => {
              const input = e.target as HTMLInputElement;
              void pickFile(input.files?.[0]);
              input.value = '';
            }}
          />
          <button
            type="button"
            class={`tm-icon-btn${props.file ? ' is-listening' : ''}`}
            data-testid="attach"
            title={
              props.file
                ? `Attached: ${props.file.name} — ask about it, or say "upload it" on a page`
                : 'Attach a PDF, image or text file (up to 50 MB) to ask about it, or to upload into a page. It stays on this computer.'
            }
            onClick={() => fileInput.current?.click()}
          >
            <Icon name="paperclip" size={16} />
          </button>
          <button
            type="button"
            class="tm-icon-btn tm-lang"
            data-testid="voice-language"
            title={`Voice language: ${language.bcp47} (click to change). Typed requests work in any language.`}
            onClick={() => void nextLanguage()}
          >
            {language.label}
          </button>
          <button
            type="button"
            class={`tm-icon-btn${voice.phase === 'listening' ? ' is-listening' : ''}`}
            data-testid="voice-input"
            aria-pressed={voice.phase === 'listening'}
            disabled={props.running || voice.phase === 'transcribing'}
            title={
              voice.phase === 'listening'
                ? 'Listening… click to finish'
                : voice.phase === 'transcribing'
                  ? 'Recognizing…'
                  : props.settings.voice.sttEngine === 'local-whisper'
                    ? 'Speak a request (local Whisper — audio stays on this computer)'
                    : 'Speak a request (Chrome speech recognition)'
            }
            onClick={voice.toggle}
          >
            <Icon name="mic" size={16} />
          </button>
          <button
            type="button"
            class={`tm-icon-btn${props.settings.voice.ttsEnabled ? ' is-listening' : ''}`}
            data-testid="voice-output"
            aria-pressed={props.settings.voice.ttsEnabled}
            title={
              props.settings.voice.ttsEnabled
                ? 'Spoken replies on (click to turn off)'
                : 'Spoken replies off (click to turn on)'
            }
            onClick={() => void toggleSpeech()}
          >
            <Icon name="volume" size={16} />
          </button>
          <button
            type="button"
            class="tm-send"
            disabled={props.running || props.draft.trim() === ''}
            title={props.running ? 'A task is running' : 'Run task'}
            data-testid="send"
            onClick={props.onSubmit}
          >
            <Icon name="arrowUp" size={16} />
          </button>
        </div>
      </div>
    </footer>
  );
}
