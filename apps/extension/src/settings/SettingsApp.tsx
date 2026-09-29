import type { BrowserAdapter } from '@techie-mind/browser';
import { PRODUCT_NAME, resolveActiveModel, type Settings } from '@techie-mind/config';
import {
  EMPTY_PROFILE,
  HealthRequest,
  HealthResponse,
  UserProfile,
  type ProfileField,
} from '@techie-mind/contracts';
import { clearProfile, loadProfile, saveProfile } from '../shared/profile-store.js';
import type { ComponentChildren } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { Icon, LogoMark, type IconName } from '../ui/icons.js';
import { saveSettings, useSettings } from '../ui/settings-store.js';
import { SkillsSection } from './SkillsSection.js';

type Section =
  'models' | 'privacy' | 'research' | 'profile' | 'skills' | 'export' | 'diagnostics' | 'about';

const SECTIONS: ReadonlyArray<{ id: Section; label: string; icon: IconName }> = [
  { id: 'models', label: 'AI & Models', icon: 'cpu' },
  { id: 'privacy', label: 'Privacy & Vision', icon: 'shield' },
  { id: 'research', label: 'Deep Research', icon: 'search' },
  { id: 'profile', label: 'Profile', icon: 'user' },
  { id: 'skills', label: 'Skills', icon: 'code' },
  { id: 'export', label: 'Export', icon: 'upload' },
  { id: 'diagnostics', label: 'Diagnostics', icon: 'activity' },
  { id: 'about', label: 'About', icon: 'info' },
];

type SaveState = { kind: 'idle' } | { kind: 'saved' } | { kind: 'error'; message: string };

interface SectionProps {
  adapter: BrowserAdapter;
  settings: Settings;
}

/** Shared save flow: validate the whole settings object, persist only if valid, report result. */
function useSaver(adapter: BrowserAdapter, settings: Settings) {
  const [state, setState] = useState<SaveState>({ kind: 'idle' });
  const save = async (patch: Record<string, unknown>) => {
    const result = await saveSettings(adapter, settings, patch);
    setState(
      result.ok ? { kind: 'saved' } : { kind: 'error', message: result.issues[0] ?? 'Invalid' },
    );
  };
  return { state, save };
}

export function SettingsApp({ adapter }: { adapter: BrowserAdapter }) {
  const { settings, loaded, loadError } = useSettings(adapter);
  const [section, setSection] = useState<Section>(() => {
    const fromHash = location.hash.slice(1) as Section;
    return SECTIONS.some((s) => s.id === fromHash) ? fromHash : 'models';
  });

  useEffect(() => {
    history.replaceState(null, '', `#${section}`);
  }, [section]);

  const props = { adapter, settings };

  return (
    <div class="tm-settings">
      <aside class="tm-nav">
        <div class="tm-nav-brand">
          <LogoMark size={34} />
          <div>
            <strong>{PRODUCT_NAME}</strong>
            <span>SETTINGS</span>
          </div>
        </div>
        <nav aria-label="Settings sections">
          {SECTIONS.map((s) => (
            <button
              key={s.id}
              type="button"
              class={`tm-nav-item${section === s.id ? ' is-active' : ''}`}
              aria-current={section === s.id ? 'page' : undefined}
              data-testid={`nav-${s.id}`}
              onClick={() => setSection(s.id)}
            >
              <Icon name={s.icon} size={16} />
              {s.label}
            </button>
          ))}
        </nav>
        <p class="tm-nav-foot">Settings are stored locally in this browser.</p>
      </aside>

      <main class="tm-content">
        {loadError ? (
          <p class="tm-alert" role="alert">
            {loadError}
          </p>
        ) : null}
        {!loaded ? <p class="tm-muted">Loading…</p> : null}
        {loaded && section === 'models' ? <ModelsSection {...props} /> : null}
        {loaded && section === 'privacy' ? <PrivacySection {...props} /> : null}
        {loaded && section === 'research' ? <ResearchSection {...props} /> : null}
        {loaded && section === 'profile' ? <ProfileSection adapter={props.adapter} /> : null}
        {loaded && section === 'skills' ? <SkillsSection adapter={adapter} /> : null}
        {loaded && section === 'export' ? <ExportSection {...props} /> : null}
        {loaded && section === 'diagnostics' ? <DiagnosticsSection adapter={adapter} /> : null}
        {loaded && section === 'about' ? <AboutSection adapter={adapter} /> : null}
      </main>
    </div>
  );
}

function PageHeader(props: { title: string; subtitle: string }) {
  return (
    <header class="tm-page-header">
      <h1>{props.title}</h1>
      <p>{props.subtitle}</p>
    </header>
  );
}

function Card(props: {
  title?: string;
  subtitle?: string;
  icon?: IconName;
  children: ComponentChildren;
}) {
  return (
    <section class="tm-panel">
      {props.title ? (
        <div class="tm-panel-head">
          {props.icon ? (
            <span class="tm-panel-icon">
              <Icon name={props.icon} size={18} />
            </span>
          ) : null}
          <div>
            <h2>{props.title}</h2>
            {props.subtitle ? <p>{props.subtitle}</p> : null}
          </div>
        </div>
      ) : null}
      {props.children}
    </section>
  );
}

function Field(props: {
  label: string;
  hint?: string;
  htmlFor: string;
  children: ComponentChildren;
}) {
  return (
    <div class="tm-field">
      <label for={props.htmlFor}>{props.label}</label>
      {props.children}
      {props.hint ? <small>{props.hint}</small> : null}
    </div>
  );
}

function SaveBar(props: { state: SaveState; onSave: () => void }) {
  return (
    <div class="tm-savebar">
      <span role="status" data-testid="save-status" class={`tm-save-${props.state.kind}`}>
        {props.state.kind === 'saved' ? 'Saved' : null}
        {props.state.kind === 'error' ? `Not saved — ${props.state.message}` : null}
      </span>
      <button type="button" class="tm-btn-save" data-testid="save-settings" onClick={props.onSave}>
        Save Settings
      </button>
    </div>
  );
}

function SubTabs<T extends string>(props: {
  tabs: ReadonlyArray<{ id: T; label: string }>;
  value: T;
  onChange: (id: T) => void;
}) {
  return (
    <div class="tm-subtabs" role="tablist">
      {props.tabs.map((t) => (
        <button
          key={t.id}
          type="button"
          role="tab"
          aria-selected={props.value === t.id}
          class={props.value === t.id ? 'is-active' : ''}
          onClick={() => props.onChange(t.id)}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}

const inputValue = (e: Event) => (e.target as HTMLInputElement).value;

function ModelsSection({ adapter, settings }: SectionProps) {
  const [tab, setTab] = useState<'ollama' | 'gateway' | 'voice'>('ollama');
  const [ollama, setOllama] = useState(settings.model.ollama);
  const [laya, setLaya] = useState(settings.model.laya);
  const [gateway, setGateway] = useState({
    endpoint: settings.model.openaiCompatible.endpoint ?? '',
    model: settings.model.openaiCompatible.model,
  });
  const [provider, setProvider] = useState(settings.model.activeProvider);
  const [voice, setVoice] = useState(settings.voice);
  const { state, save } = useSaver(adapter, settings);
  const active = resolveActiveModel(settings);

  const onSave = () =>
    void save({
      model: {
        activeProvider: provider,
        ollama,
        laya: { ...laya, token: laya.token.trim() },
        openaiCompatible: { endpoint: gateway.endpoint.trim() || null, model: gateway.model },
      },
      voice,
    });

  return (
    <>
      <PageHeader
        title="AI & Models"
        subtitle="Configure local on-device inference via Ollama or connect an OpenAI-compatible gateway."
      />
      <p class="tm-active-model" data-testid="active-model">
        Active model: <strong>{active.label}</strong> ({active.local ? 'local' : 'gateway'}
        {active.configured ? '' : ', not configured'}) · checked before each model call and never
        swapped for another model. Models are asked only when code is unsure.
      </p>
      <SubTabs
        tabs={[
          { id: 'ollama', label: 'Local Model (Ollama)' },
          { id: 'gateway', label: 'Compatible (OpenAI Compatible)' },
          { id: 'voice', label: 'Voice & Audio (Speech / TTS)' },
        ]}
        value={tab}
        onChange={setTab}
      />
      {tab === 'ollama' ? (
        <Card
          icon="lock"
          title="Ollama Server Configuration"
          subtitle="Run models completely on your machine. Data never leaves your device."
        >
          <Field label="Ollama Server URL" htmlFor="ollama-url" hint="Must be a loopback address.">
            <input
              id="ollama-url"
              class="tm-text"
              value={ollama.baseUrl}
              onInput={(e) => setOllama({ ...ollama, baseUrl: inputValue(e) })}
            />
          </Field>
          <Field
            label="Selected Model"
            htmlFor="ollama-model"
            hint="Pull it first with `ollama pull <model>`. qwen2.5vl:7b reads both text and screenshots."
          >
            <input
              id="ollama-model"
              class="tm-text"
              data-testid="ollama-model"
              value={ollama.model}
              onInput={(e) => setOllama({ ...ollama, model: inputValue(e) })}
            />
          </Field>
          <label class="tm-check">
            <input
              type="radio"
              name="provider"
              checked={provider === 'ollama'}
              onChange={() => setProvider('ollama')}
            />
            Use the local model as the active model
          </label>
        </Card>
      ) : null}
      {tab === 'ollama' ? (
        <Card
          icon="bolt"
          title="Laya — Fast Local Decisions"
          subtitle="A small model that sorts unclear commands in milliseconds, before the larger model is asked."
        >
          <label class="tm-check">
            <input
              type="checkbox"
              data-testid="laya-enabled"
              checked={laya.enabled}
              onChange={(e) =>
                setLaya({ ...laya, enabled: (e.target as HTMLInputElement).checked })
              }
            />
            Ask Laya first
          </label>
          <Field
            label="Laya Adapter URL"
            htmlFor="laya-url"
            hint="Start it with scripts/laya/laya_adapter.py. Must be a loopback address."
          >
            <input
              id="laya-url"
              class="tm-text"
              value={laya.adapterUrl}
              onInput={(e) => setLaya({ ...laya, adapterUrl: inputValue(e) })}
            />
          </Field>
          <Field
            label="Adapter Token"
            htmlFor="laya-token"
            hint="Copy it exactly with: pbcopy < ~/.config/techie-mind/laya.token (cat shows an extra % in zsh — don't paste that). It only authenticates this browser to the local adapter."
          >
            <input
              id="laya-token"
              type="password"
              class="tm-text"
              data-testid="laya-token"
              autocomplete="off"
              value={laya.token}
              onInput={(e) => setLaya({ ...laya, token: inputValue(e) })}
            />
          </Field>
        </Card>
      ) : null}
      {tab === 'gateway' ? (
        <Card
          icon="bolt"
          title="OpenAI-Compatible Gateway"
          subtitle="Connect OpenAI, self-hosted vLLM, LiteLLM, or compatible endpoints."
        >
          <Field label="Endpoint URL" htmlFor="gw-endpoint" hint="https only.">
            <input
              id="gw-endpoint"
              class="tm-text"
              placeholder="https://api.openai.com/v1"
              value={gateway.endpoint}
              onInput={(e) => setGateway({ ...gateway, endpoint: inputValue(e) })}
            />
          </Field>
          <Field label="Model Name" htmlFor="gw-model">
            <input
              id="gw-model"
              class="tm-text"
              value={gateway.model}
              onInput={(e) => setGateway({ ...gateway, model: inputValue(e) })}
            />
          </Field>
          <p class="tm-note">
            API keys are never stored in the browser. Point this at a gateway you run (for example
            LiteLLM) that holds the provider key; requests pass the privacy gate first.
          </p>
          <label class="tm-check">
            <input
              type="radio"
              name="provider"
              checked={provider === 'openai-compatible'}
              onChange={() => setProvider('openai-compatible')}
            />
            Use the gateway as the active model
          </label>
        </Card>
      ) : null}
      {tab === 'voice' ? (
        <Card
          icon="mic"
          title="Voice Input & Spoken Output"
          subtitle="Stored now; voice capture and speech output are implemented in Phase 7."
        >
          <Field label="Recognition Engine" htmlFor="stt">
            <select id="stt" class="tm-text" value={voice.sttEngine} disabled>
              <option value="web-speech">Browser Web Speech API</option>
            </select>
          </Field>
          <label class="tm-check">
            <input
              type="checkbox"
              checked={voice.ttsEnabled}
              onChange={(e) =>
                setVoice({ ...voice, ttsEnabled: (e.target as HTMLInputElement).checked })
              }
            />
            Speak concise summaries after tasks complete
          </label>
          <Field label="Voice Persona" htmlFor="persona">
            <select
              id="persona"
              class="tm-text"
              value={voice.voicePersona}
              onChange={(e) =>
                setVoice({
                  ...voice,
                  voicePersona: inputValue(e) as Settings['voice']['voicePersona'],
                })
              }
            >
              <option value="system-default">System default</option>
              <option value="female-natural">Female (natural)</option>
              <option value="male-natural">Male (natural)</option>
            </select>
          </Field>
        </Card>
      ) : null}
      <SaveBar state={state} onSave={onSave} />
    </>
  );
}

function PrivacySection({ adapter, settings }: SectionProps) {
  const [privacy, setPrivacy] = useState(settings.privacy);
  const { state, save } = useSaver(adapter, settings);
  const toggle = (key: 'enabled' | 'faceBlurring' | 'domPiiRedaction' | 'tabGroupSandbox') =>
    setPrivacy({ ...privacy, [key]: !privacy[key] });

  const rows: ReadonlyArray<{ key: Parameters<typeof toggle>[0]; title: string; body: string }> = [
    {
      key: 'enabled',
      title: 'Enable Privacy Boundary',
      body: 'Enforces client-side sanitization. Fails closed if sanitization errors occur.',
    },
    {
      key: 'faceBlurring',
      title: 'Local Face Blurring',
      body: 'Masks human faces in page captures using an on-device model.',
    },
    {
      key: 'domPiiRedaction',
      title: 'DOM PII Redaction',
      body: 'Masks emails, phone numbers and credentials before building page context.',
    },
    {
      key: 'tabGroupSandbox',
      title: 'Chrome Tab Groups Sandbox',
      body: 'Groups agent tabs into a coloured tab group.',
    },
  ];

  return (
    <>
      <PageHeader
        title="Privacy & Vision"
        subtitle="Local client-side sanitization, PII masking and fail-closed privacy bounds."
      />
      <p class="tm-note" data-testid="privacy-phase-note">
        These choices are saved now. The detection and redaction engine that enforces them is
        implemented in Phase 2; until then no page content is captured or sent anywhere.
      </p>
      <Card
        icon="shield"
        title="Privacy Wall Safeguards"
        subtitle="All sensitive information is redacted locally in the browser before model inference."
      >
        {rows.map((r) => (
          <label class="tm-toggle-row" key={r.key}>
            <input
              type="checkbox"
              data-testid={`privacy-${r.key}`}
              checked={privacy[r.key]}
              onChange={() => toggle(r.key)}
            />
            <span>
              <strong>{r.title}</strong>
              <small>{r.body}</small>
            </span>
          </label>
        ))}
        <label class="tm-toggle-row is-locked">
          <input type="checkbox" checked disabled />
          <span>
            <strong>
              Indian Identity &amp; Financial Redaction <em>(always on)</em>
            </strong>
            <small>
              Aadhaar, PAN, voter ID, passport, driving licence, IFSC, UPI and GSTIN are masked
              unconditionally and cannot be switched off.
            </small>
          </span>
        </label>
        <Field label="Vision & Sanitization Speed Profile" htmlFor="vision-profile">
          <select
            id="vision-profile"
            class="tm-text"
            value={privacy.visionSpeedProfile}
            onChange={(e) =>
              setPrivacy({
                ...privacy,
                visionSpeedProfile: inputValue(e) as Settings['privacy']['visionSpeedProfile'],
              })
            }
          >
            <option value="fast">Fast</option>
            <option value="balanced">Balanced</option>
            <option value="accurate">Accurate</option>
          </select>
        </Field>
      </Card>
      <SaveBar state={state} onSave={() => void save({ privacy })} />
    </>
  );
}

function ResearchSection({ adapter, settings }: SectionProps) {
  const [maxSites, setMaxSites] = useState(String(settings.research.maxSitesPerQuery));
  const { state, save } = useSaver(adapter, settings);
  return (
    <>
      <PageHeader
        title="Deep Research"
        subtitle="Crawling parameters for multi-source research tasks."
      />
      <Card title="Research Limits">
        <Field label="Max Sites to Crawl per Query" htmlFor="max-sites" hint="1–20.">
          <input
            id="max-sites"
            class="tm-text"
            type="number"
            min={1}
            max={20}
            value={maxSites}
            onInput={(e) => setMaxSites(inputValue(e))}
          />
        </Field>
        <p class="tm-note">
          Search-provider API keys are credentials and are configured with the server-side gateway
          (Phase 3/6), not stored in browser settings.
        </p>
      </Card>
      <SaveBar
        state={state}
        onSave={() => void save({ research: { maxSitesPerQuery: Number(maxSites) } })}
      />
    </>
  );
}

const PROFILE_LABELS: Array<[ProfileField, string, string]> = [
  ['fullName', 'Full name', 'name'],
  ['email', 'Email', 'email'],
  ['phone', 'Phone', 'tel'],
  ['addressLine1', 'Address line 1', 'address-line1'],
  ['addressLine2', 'Address line 2', 'address-line2'],
  ['city', 'City', 'address-level2'],
  ['state', 'State', 'address-level1'],
  ['postalCode', 'PIN code', 'postal-code'],
  ['country', 'Country', 'country-name'],
];

function ProfileSection({ adapter }: { adapter: BrowserAdapter }) {
  const [profile, setProfile] = useState<UserProfile>(EMPTY_PROFILE);
  const [status, setStatus] = useState<string>('');
  useEffect(() => {
    void loadProfile(adapter).then((p) => p && setProfile(p));
  }, [adapter]);
  const onSave = async () => {
    const parsed = UserProfile.safeParse(profile);
    if (!parsed.success) {
      setStatus('Not saved — a value is too long');
      return;
    }
    try {
      await saveProfile(adapter, parsed.data);
      setStatus('Saved (encrypted on this device)');
    } catch (error) {
      setStatus(`Not saved — ${error instanceof Error ? error.message : 'error'}`);
    }
  };
  const onClear = async () => {
    await clearProfile(adapter);
    setProfile(EMPTY_PROFILE);
    setStatus('Profile removed');
  };
  return (
    <>
      <PageHeader
        title="User Profile"
        subtitle={
          'Saved personal details used for form filling ("fill this form with my profile").'
        }
      />
      <Card
        icon="lock"
        title="Encrypted on this device"
        subtitle="AES-GCM with a key that never leaves this browser. Models only ever see tokens like PHONE_001; the agent never submits a form for you."
      >
        {PROFILE_LABELS.map(([field, label, autocomplete]) => (
          <Field key={field} label={label} htmlFor={`profile-${field}`}>
            <input
              id={`profile-${field}`}
              class="tm-text"
              data-testid={`profile-${field}`}
              autocomplete={autocomplete}
              value={profile[field]}
              onInput={(e) => setProfile({ ...profile, [field]: inputValue(e) })}
            />
          </Field>
        ))}
        <p class="tm-note">
          Passwords, OTPs and card details are never stored here and never filled by the agent.
        </p>
      </Card>
      <div class="tm-savebar">
        <span role="status" data-testid="profile-status">
          {status}
        </span>
        <button type="button" class="tm-btn-outline" onClick={() => void onClear()}>
          Remove profile
        </button>
        <button
          type="button"
          class="tm-btn-save"
          data-testid="save-profile"
          onClick={() => void onSave()}
        >
          Save Profile
        </button>
      </div>
    </>
  );
}

function ExportSection({ adapter, settings }: SectionProps) {
  const [exp, setExp] = useState(settings.export);
  const { state, save } = useSaver(adapter, settings);
  return (
    <>
      <PageHeader
        title="Export & Storage"
        subtitle="Default export format and folder for extracted data."
      />
      <Card>
        <Field label="Preferred Export Format" htmlFor="export-format">
          <select
            id="export-format"
            class="tm-text"
            value={exp.format}
            onChange={(e) => setExp({ ...exp, format: inputValue(e) as 'json' | 'csv' })}
          >
            <option value="json">JSON</option>
            <option value="csv">CSV</option>
          </select>
        </Field>
        <Field
          label="Default Export Folder"
          htmlFor="export-folder"
          hint="Exports are saved under Downloads/<folder>. Folder name only."
        >
          <input
            id="export-folder"
            class="tm-text"
            data-testid="export-folder"
            value={exp.folder}
            onInput={(e) => setExp({ ...exp, folder: inputValue(e) })}
          />
        </Field>
      </Card>
      <SaveBar state={state} onSave={() => void save({ export: exp })} />
    </>
  );
}

type Check = { status: 'idle' | 'running' | 'pass' | 'fail'; detail: string };

function DiagnosticsSection({ adapter }: { adapter: BrowserAdapter }) {
  const [system, setSystem] = useState<Check>({ status: 'idle', detail: '' });

  const runSystemTest = async () => {
    setSystem({ status: 'running', detail: 'Contacting background service worker…' });
    const started = performance.now();
    try {
      const reply = HealthResponse.safeParse(
        await adapter.sendMessage(HealthRequest.parse({ type: 'HEALTH_REQUEST' })),
      );
      const ms = Math.round(performance.now() - started);
      setSystem(
        reply.success
          ? {
              status: 'pass',
              detail: `Service worker healthy (${reply.data.browser}, v${reply.data.version}) · round trip ${ms} ms`,
            }
          : { status: 'fail', detail: 'Service worker replied with an invalid response' },
      );
    } catch (err) {
      setSystem({ status: 'fail', detail: err instanceof Error ? err.message : String(err) });
    }
  };

  return (
    <>
      <PageHeader
        title="Diagnostics"
        subtitle="Checks against local services and the extension runtime."
      />
      <Card>
        <div class="tm-diag-row">
          <span>
            <strong>System Test</strong>
            <small>Validates the background service worker and the messaging contract.</small>
            {system.detail ? (
              <small data-testid="system-test-result" class={`tm-diag-${system.status}`}>
                {system.status === 'pass' ? 'PASS · ' : system.status === 'fail' ? 'FAIL · ' : ''}
                {system.detail}
              </small>
            ) : null}
          </span>
          <button
            type="button"
            class="tm-btn-outline"
            data-testid="run-system-test"
            disabled={system.status === 'running'}
            onClick={() => void runSystemTest()}
          >
            Run System Test
          </button>
        </div>
        <div class="tm-diag-row">
          <span>
            <strong>Privacy Test</strong>
            <small>Face detection, credential masking and Indian PII patterns — Phase 2.</small>
          </span>
          <button type="button" class="tm-btn-outline" disabled>
            Run Privacy Test
          </button>
        </div>
        <div class="tm-diag-row">
          <span>
            <strong>Service Connection</strong>
            <small>Connection to the active model endpoint — Phase 3.</small>
          </span>
          <button type="button" class="tm-btn-outline" disabled>
            Check Service
          </button>
        </div>
      </Card>
      <Card
        icon="activity"
        title="SIH Evaluation & Demo Lab"
        subtitle="Benchmark dashboard and demo launchers are built in Phase 10."
      >
        <p class="tm-muted">No benchmarks have been run yet.</p>
      </Card>
    </>
  );
}

function AboutSection({ adapter }: { adapter: BrowserAdapter }) {
  return (
    <>
      <PageHeader title="About" subtitle="" />
      <Card>
        <div class="tm-about">
          <LogoMark size={56} />
          <h2>{PRODUCT_NAME}</h2>
          <p>A privacy-first browser agent for research, navigation and web tasks.</p>
          <small data-testid="about-version">
            Version {adapter.version} · {adapter.kind === 'chrome' ? 'Chrome' : 'Firefox'} build
          </small>
        </div>
      </Card>
    </>
  );
}
