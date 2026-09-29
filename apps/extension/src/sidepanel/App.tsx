import type { BrowserAdapter } from '@techie-mind/browser';
import { PRODUCT_NAME, resolveActiveModel, type Settings } from '@techie-mind/config';
import { OpenSettingsRequest, type TaskMode } from '@techie-mind/contracts';
import { useEffect, useRef, useState } from 'preact/hooks';
import { Icon, LogoMark, type IconName } from '../ui/icons.js';
import { saveSettings, useSettings } from '../ui/settings-store.js';
import { RunView } from './activity.js';
import { HistoryView } from './history.js';
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

  const submit = (text: string, source: 'typed' | 'rerun' | 'voice' = 'typed') => {
    const trimmed = text.trim();
    if (!trimmed || runner.state.phase === 'running') return;
    setView('agent');
    setDraft('');
    if (settings.agent.autonomy === 'ask-before-acting') runner.preview(trimmed);
    else runner.run(trimmed, mode, source);
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
          <AgentView onOpenSettings={openSettings} />
        ) : null}
        {view === 'agent' && runner.state.phase !== 'idle' ? (
          <RunView
            state={runner.state}
            onRun={() => runner.run(runner.state.text, mode)}
            onCancel={runner.reset}
            onControl={runner.control}
            onResume={runner.resume}
          />
        ) : null}
        {view === 'history' ? (
          <HistoryView adapter={adapter} onRerun={(text) => submit(text, 'rerun')} />
        ) : null}
        {view === 'privacy' ? <PrivacyView settings={settings} /> : null}
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
          onSubmit={() => submit(draft)}
          onVoice={(text) => submit(text, 'voice')}
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

const QUICK_ACTIONS: ReadonlyArray<{
  id: string;
  title: string;
  subtitle: string;
  icon: IconName;
  availableIn: string | null;
  tone?: 'success';
}> = [
  {
    id: 'summaries',
    title: 'Summaries',
    subtitle: 'Key points of this page',
    icon: 'fileText',
    availableIn: 'Phase 6',
  },
  {
    id: 'extract',
    title: 'Extract Data',
    subtitle: 'Page → JSON · CSV',
    icon: 'layout',
    availableIn: 'Phase 6',
  },
  {
    id: 'research',
    title: 'Deep Research',
    subtitle: 'Multi-source report',
    icon: 'search',
    availableIn: 'Phase 6',
  },
  {
    id: 'private',
    title: 'Private Run',
    subtitle: 'On-device, no cloud',
    icon: 'shieldCheck',
    availableIn: 'Phase 3',
    tone: 'success',
  },
];

function AgentView({ onOpenSettings }: { onOpenSettings: () => void }) {
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
            onClick={() => setNotice(`${a.title} is implemented in ${a.availableIn}.`)}
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

function PrivacyView({ settings }: { settings: Settings }) {
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
          <span class="tm-tag">Phase 2</span>
        </div>
        <ul class="tm-detector-list">
          {DETECTORS.map((d) => (
            <li key={d}>
              <span>{d}</span>
              <small>configured · enforcement arrives in Phase 2</small>
            </li>
          ))}
        </ul>
      </div>
      <div class="tm-card">
        <h3>Privacy inspector</h3>
        <p class="tm-muted">
          No active capture. When a task runs, this shows what was captured, what was redacted and
          why, and exactly what was sent.
        </p>
      </div>
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
}) {
  const { mode } = props;
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
      <textarea
        id="tm-task-input"
        class="tm-input"
        rows={2}
        placeholder="Ask anything — type / for skills"
        value={props.draft}
        data-testid="task-input"
        onInput={(e) => props.onDraft((e.target as HTMLTextAreaElement).value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            props.onSubmit();
          }
        }}
      />

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
          <button type="button" class="tm-icon-btn" disabled title="Attachments — Phase 6">
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
