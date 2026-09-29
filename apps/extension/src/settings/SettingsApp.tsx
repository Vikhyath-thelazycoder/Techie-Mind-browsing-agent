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
import { checkServices, privacyTest, type ServiceCheck } from './diagnostics.js';
import {
  COUNTRIES,
  COUNTRY_CODES,
  INDIAN_CITIES,
  INDIAN_STATES,
  splitCitySuggestion,
  splitPhone,
} from './places.js';
import { SkillsSection } from './SkillsSection.js';
import {
  MonitoringClient,
  type BackendMonitor,
  type MonitorAction,
} from '../shared/monitoring-client.js';

type Section =
  | 'models'
  | 'privacy'
  | 'research'
  | 'profile'
  | 'skills'
  | 'monitoring'
  | 'export'
  | 'diagnostics'
  | 'about';

const SECTIONS: ReadonlyArray<{ id: Section; label: string; icon: IconName }> = [
  { id: 'models', label: 'AI & Models', icon: 'cpu' },
  { id: 'privacy', label: 'Privacy & Vision', icon: 'shield' },
  { id: 'research', label: 'Deep Research', icon: 'search' },
  { id: 'profile', label: 'Profile', icon: 'user' },
  { id: 'skills', label: 'Skills', icon: 'code' },
  { id: 'monitoring', label: 'Monitoring', icon: 'clock' },
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
        {loaded && section === 'monitoring' ? <MonitoringSection {...props} /> : null}
        {loaded && section === 'export' ? <ExportSection {...props} /> : null}
        {loaded && section === 'diagnostics' ? <DiagnosticsSection {...props} /> : null}
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
  const [language, setLanguage] = useState(settings.language.preferredInputLanguage);
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
      language: { preferredInputLanguage: language },
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
          subtitle="Speak a request in English, Hindi, Kannada, Tamil or Telugu; it runs exactly like a typed one."
        >
          <Field
            label="Recognition Engine"
            htmlFor="stt"
            hint={
              voice.sttEngine === 'local-whisper'
                ? 'Audio goes only to a whisper.cpp server on this computer (see docs/VOICE.md).'
                : 'Chrome sends your audio to Google to recognize it. Only used after you agree below.'
            }
          >
            <select
              id="stt"
              class="tm-text"
              data-testid="stt-engine"
              value={voice.sttEngine}
              onChange={(e) =>
                setVoice({
                  ...voice,
                  sttEngine: inputValue(e) as Settings['voice']['sttEngine'],
                })
              }
            >
              <option value="local-whisper">Local Whisper (private, on this computer)</option>
              <option value="web-speech">Chrome Web Speech (audio sent to Google)</option>
            </select>
          </Field>
          {voice.sttEngine === 'local-whisper' ? (
            <Field
              label="Local Whisper URL"
              htmlFor="stt-url"
              hint="whisper.cpp server: ./build/bin/whisper-server -m models/ggml-small.bin --port 8178 --convert. Loopback only."
            >
              <input
                id="stt-url"
                class="tm-text"
                data-testid="stt-url"
                value={voice.localSttUrl}
                onInput={(e) => setVoice({ ...voice, localSttUrl: inputValue(e) })}
              />
            </Field>
          ) : (
            <label class="tm-check">
              <input
                type="checkbox"
                data-testid="web-speech-consent"
                checked={voice.webSpeechConsent}
                onChange={(e) =>
                  setVoice({ ...voice, webSpeechConsent: (e.target as HTMLInputElement).checked })
                }
              />
              I agree that Chrome sends my voice recordings to Google for recognition
            </label>
          )}
          <Field
            label="Voice Language"
            htmlFor="voice-lang"
            hint="Also switchable with the language button next to the mic."
          >
            <select
              id="voice-lang"
              class="tm-text"
              value={language}
              onChange={(e) =>
                setLanguage(inputValue(e) as Settings['language']['preferredInputLanguage'])
              }
            >
              <option value="en">English</option>
              <option value="hi">Hindi</option>
              <option value="kn">Kannada</option>
              <option value="ta">Tamil</option>
              <option value="te">Telugu</option>
            </select>
          </Field>
          <MicrophoneAccess />
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
        The privacy engine is active: every page is scanned on this device and sensitive values are
        masked before anything reaches a model or leaves the browser. Run the check in Diagnostics →
        Privacy Test.
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
          No API key is needed: research reads public search pages (Google, or DuckDuckGo when
          Google asks for a human check) and the sources it opens, then summarizes them locally.
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
        subtitle="AES-GCM with a key that never leaves this browser. Models only ever see tokens like PHONE_001; the agent submits a form only when you say "submit the form" and confirm it."
      >
        {/* A real <form> with name/autocomplete lets Chrome autofill and paste work normally. */}
        <form autocomplete="on" onSubmit={(e) => e.preventDefault()}>
          {PROFILE_LABELS.map(([field, label, autocomplete]) => {
            if (field === 'phone') {
              const [code, number] = splitPhone(profile.phone);
              const setPhone = (c: string, n: string) =>
                setProfile({ ...profile, phone: n.trim() ? `${c} ${n.trim()}` : '' });
              return (
                <Field key={field} label={label} htmlFor="profile-phone">
                  <div class="tm-phone">
                    <select
                      class="tm-text tm-phone-code"
                      aria-label="Country code"
                      autocomplete="tel-country-code"
                      value={code}
                      onChange={(e) => setPhone(inputValue(e), number)}
                    >
                      {COUNTRY_CODES.map(([c, country]) => (
                        <option key={c} value={c}>
                          {c} {country}
                        </option>
                      ))}
                    </select>
                    <input
                      id="profile-phone"
                      name="tel-national"
                      class="tm-text"
                      type="tel"
                      inputMode="tel"
                      data-testid="profile-phone"
                      autocomplete="tel-national"
                      placeholder="98765 43210"
                      value={number}
                      onInput={(e) => setPhone(code, inputValue(e).replace(/^\+\d{1,4}\s*/, ''))}
                    />
                  </div>
                </Field>
              );
            }
            const list =
              field === 'city'
                ? 'profile-cities'
                : field === 'state'
                  ? 'profile-states'
                  : field === 'country'
                    ? 'profile-countries'
                    : undefined;
            return (
              <Field key={field} label={label} htmlFor={`profile-${field}`}>
                <input
                  id={`profile-${field}`}
                  name={autocomplete}
                  class="tm-text"
                  data-testid={`profile-${field}`}
                  autocomplete={autocomplete}
                  list={list}
                  value={profile[field]}
                  onInput={(e) => {
                    const value = inputValue(e);
                    if (field === 'city') {
                      // "Bengaluru, Karnataka" from the suggestions fills the state and country too.
                      const { city, state } = splitCitySuggestion(value);
                      setProfile({
                        ...profile,
                        city,
                        ...(state ? { state, country: profile.country || 'India' } : {}),
                      });
                    } else {
                      setProfile({ ...profile, [field]: value });
                    }
                  }}
                />
              </Field>
            );
          })}
          <datalist id="profile-cities">
            {INDIAN_CITIES.map(([city, state]) => (
              <option key={`${city}-${state}`} value={`${city}, ${state}`} />
            ))}
          </datalist>
          <datalist id="profile-states">
            {INDIAN_STATES.map((s) => (
              <option key={s} value={s} />
            ))}
          </datalist>
          <datalist id="profile-countries">
            {COUNTRIES.map((c) => (
              <option key={c} value={c} />
            ))}
          </datalist>
        </form>
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

function DiagnosticsSection({ adapter, settings }: SectionProps) {
  const [system, setSystem] = useState<Check>({ status: 'idle', detail: '' });
  const [privacy, setPrivacy] = useState<ServiceCheck | null>(null);
  const [services, setServices] = useState<ServiceCheck[] | 'running' | null>(null);
  const runServices = async () => {
    setServices('running');
    setServices(await checkServices(settings));
  };

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
            <small>
              Runs the on-device redaction engine on made-up personal data (phone, e-mail, PAN,
              card) and checks that nothing raw is left.
            </small>
            {privacy ? (
              <small
                data-testid="privacy-test-result"
                class={`tm-diag-${privacy.ok ? 'pass' : 'fail'}`}
              >
                {privacy.ok ? 'PASS · ' : 'FAIL · '}
                {privacy.detail}
              </small>
            ) : null}
          </span>
          <button
            type="button"
            class="tm-btn-outline"
            data-testid="run-privacy-test"
            onClick={() => setPrivacy(privacyTest())}
          >
            Run Privacy Test
          </button>
        </div>
        <div class="tm-diag-row">
          <span>
            <strong>Service Connection</strong>
            <small>Ollama, Laya, the local voice server and your monitoring backend.</small>
            {services === 'running' ? <small>Checking…</small> : null}
            {Array.isArray(services)
              ? services.map((s) => (
                  <small key={s.name} class={`tm-diag-${s.ok ? 'pass' : 'fail'}`}>
                    {s.ok ? 'PASS · ' : 'FAIL · '}
                    {s.name}: {s.detail}
                  </small>
                ))
              : null}
          </span>
          <button
            type="button"
            class="tm-btn-outline"
            data-testid="check-services"
            disabled={services === 'running'}
            onClick={() => void runServices()}
          >
            Check Services
          </button>
        </div>
      </Card>
      <Card
        icon="activity"
        title="SIH Evaluation & Demo Lab"
        subtitle="Benchmark dashboard and demo launchers arrive in Batch D (final phase)."
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

/**
 * The side panel cannot show Chrome's microphone prompt, so access is granted once here, on an
 * extension page; the permission then covers the side panel too.
 */
function MicrophoneAccess() {
  const [status, setStatus] = useState<string | null>(null);
  const allow = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach((t) => t.stop());
      setStatus('Microphone allowed. You can use the mic in the side panel now.');
    } catch {
      setStatus(
        'Microphone was blocked. Allow it in Chrome (address bar → site settings for this extension), then try again.',
      );
    }
  };
  return (
    <div class="tm-field">
      <button
        type="button"
        class="tm-btn-save"
        data-testid="allow-microphone"
        onClick={() => void allow()}
      >
        Allow microphone
      </button>
      {status ? (
        <p class="tm-muted" role="status" data-testid="microphone-status">
          {status}
        </p>
      ) : null}
    </div>
  );
}

// ── Monitoring (Phase 8) ─────────────────────────────────────────────────────────────────────

function describeMonitor(m: BackendMonitor): string {
  const money = (v: number) =>
    `${m.currency === 'USD' ? '$' : m.currency === 'EUR' ? '€' : m.currency === 'GBP' ? '£' : '₹'}${Number(v).toLocaleString('en-IN')}`;
  const what =
    m.kind === 'price-below' && m.threshold !== null
      ? `price at or below ${money(m.threshold)}`
      : m.kind === 'available'
        ? 'back in stock'
        : 'page changes';
  const now =
    m.kind === 'price-below' && m.last_value !== null
      ? ` · now ${money(m.last_value)}`
      : m.kind === 'available' && m.last_available !== null
        ? ` · ${m.last_available ? 'in stock' : 'out of stock'}`
        : '';
  return `${what}${now} · every ${m.interval_minutes} min`;
}

function when(iso: string | null): string {
  return iso
    ? new Date(iso).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' })
    : 'not yet';
}

/**
 * Persistent monitoring: connect YOUR Supabase project (URL + public anon key), sign in, and manage
 * monitors. Checks and e-mail alerts run on the backend, also while Chrome is closed.
 */
function MonitoringSection({ adapter, settings }: SectionProps) {
  const [apiUrl, setApiUrl] = useState(settings.monitoring.apiUrl ?? '');
  const [anonKey, setAnonKey] = useState(settings.monitoring.anonKey);
  const { state, save } = useSaver(adapter, settings);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [who, setWho] = useState<string | null>(null);
  const [monitors, setMonitors] = useState<BackendMonitor[] | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const client = new MonitoringClient(adapter, settings.monitoring);

  const refresh = async () => {
    if (!client.configured) return;
    const signedIn = await client.who();
    setWho(signedIn);
    if (!signedIn) return;
    try {
      setMonitors(await client.list());
    } catch (e) {
      setMessage(e instanceof Error ? e.message : 'Could not load monitors.');
    }
  };

  useEffect(() => {
    void refresh();
    // Reload whenever the saved connection changes.
  }, [settings.monitoring.apiUrl, settings.monitoring.anonKey]);

  const run = async (task: () => Promise<string | void>) => {
    setBusy(true);
    setMessage(null);
    try {
      const done = await task();
      if (done) setMessage(done);
      await refresh();
    } catch (e) {
      setMessage(e instanceof Error ? e.message : 'Something went wrong.');
    } finally {
      setBusy(false);
    }
  };

  const act = (action: MonitorAction, id: string) =>
    void run(async () => {
      if (action === 'delete' && !confirm('Delete this monitor and its history?')) return;
      await client.control(action, id);
      return action === 'check-now' ? 'It will be checked within 5 minutes.' : undefined;
    });

  return (
    <>
      <PageHeader
        title="Monitoring"
        subtitle="Price, stock and page-change alerts by e-mail — checked by your own backend, even while Chrome is closed."
      />
      <Card
        icon="clock"
        title="Monitoring backend (Supabase)"
        subtitle="Your own Supabase project. Only its URL and public anon key are stored here; server secrets stay in Supabase (docs/MONITORING_BACKEND.md)."
      >
        <Field label="Project URL" htmlFor="mon-url" hint="https://<project-ref>.supabase.co">
          <input
            id="mon-url"
            class="tm-text"
            data-testid="monitoring-url"
            placeholder="https://abcd1234.supabase.co"
            value={apiUrl}
            onInput={(e) => setApiUrl(inputValue(e))}
          />
        </Field>
        <Field
          label="Anon (public) key"
          htmlFor="mon-key"
          hint="Supabase → Project Settings → API → anon public. Never paste the service_role key here."
        >
          <input
            id="mon-key"
            class="tm-text"
            data-testid="monitoring-anon-key"
            autocomplete="off"
            value={anonKey}
            onInput={(e) => setAnonKey(inputValue(e).trim())}
          />
        </Field>
      </Card>
      <SaveBar
        state={state}
        onSave={() =>
          void save({ monitoring: { apiUrl: apiUrl.trim() || null, anonKey: anonKey.trim() } })
        }
      />

      {client.configured ? (
        <Card
          icon="user"
          title="Account"
          subtitle="Alerts go to this account's confirmed e-mail address. The password goes only to Supabase and is never stored."
        >
          {who ? (
            <div class="tm-card-row">
              <span data-testid="monitoring-account">
                Signed in as <strong>{who}</strong>
              </span>
              <button
                type="button"
                class="tm-btn-ghost"
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    await client.signOut();
                    setMonitors(null);
                    return 'Signed out.';
                  })
                }
              >
                Sign out
              </button>
            </div>
          ) : (
            <>
              <Field label="E-mail" htmlFor="mon-email">
                <input
                  id="mon-email"
                  type="email"
                  class="tm-text"
                  data-testid="monitoring-email"
                  autocomplete="username"
                  value={email}
                  onInput={(e) => setEmail(inputValue(e).trim())}
                />
              </Field>
              <Field label="Password" htmlFor="mon-password">
                <input
                  id="mon-password"
                  type="password"
                  class="tm-text"
                  data-testid="monitoring-password"
                  autocomplete="current-password"
                  value={password}
                  onInput={(e) => setPassword(inputValue(e))}
                />
              </Field>
              <div class="tm-plan-actions">
                <button
                  type="button"
                  class="tm-btn-ghost"
                  disabled={busy || !email || password.length < 8}
                  data-testid="monitoring-signup"
                  onClick={() =>
                    void run(async () => {
                      const r = await client.signUp(email, password);
                      setPassword('');
                      return r === 'confirm-email'
                        ? 'Account created. Open the confirmation e-mail from Supabase, then sign in here.'
                        : 'Account created and signed in.';
                    })
                  }
                >
                  Create account
                </button>
                <button
                  type="button"
                  class="tm-btn-save"
                  disabled={busy || !email || !password}
                  data-testid="monitoring-signin"
                  onClick={() =>
                    void run(async () => {
                      await client.signIn(email, password);
                      setPassword('');
                      return 'Signed in.';
                    })
                  }
                >
                  Sign in
                </button>
              </div>
            </>
          )}
        </Card>
      ) : null}

      {who ? (
        <Card
          icon="activity"
          title="Your monitors"
          subtitle='Create one from the side panel on a product page: "monitor this product until the price drops below ₹50,000".'
        >
          <div class="tm-card-row">
            <span class="tm-muted">
              {monitors
                ? `${monitors.length} monitor${monitors.length === 1 ? '' : 's'}`
                : 'Loading…'}
            </span>
            <span>
              <button
                type="button"
                class="tm-btn-ghost"
                data-testid="send-test-email"
                disabled={busy}
                title="Send one test alert to your account's e-mail address"
                onClick={() =>
                  void run(async () => {
                    const to = await client.sendTestEmail();
                    return `Test e-mail sent to ${to}. It should arrive within a minute.`;
                  })
                }
              >
                Send test e-mail
              </button>
              <button
                type="button"
                class="tm-btn-ghost"
                disabled={busy}
                onClick={() => void run(async () => undefined)}
              >
                Refresh
              </button>
            </span>
          </div>
          <ul class="tm-monitor-list" data-testid="monitor-list">
            {(monitors ?? []).map((m) => (
              <li key={m.id} data-status={m.status}>
                <div>
                  <strong>{m.label || new URL(m.url).hostname}</strong>
                  <small class="tm-muted">{m.url}</small>
                  <small>
                    {describeMonitor(m)} · <b>{m.status}</b> · last check {when(m.last_checked_at)}
                  </small>
                  {m.last_error ? (
                    <small class="tm-bad-text">Last problem: {m.last_error}</small>
                  ) : null}
                </div>
                <div class="tm-plan-actions">
                  {m.status === 'active' ? (
                    <>
                      <button
                        type="button"
                        class="tm-btn-ghost"
                        disabled={busy}
                        onClick={() => act('check-now', m.id)}
                      >
                        Check now
                      </button>
                      <button
                        type="button"
                        class="tm-btn-ghost"
                        disabled={busy}
                        onClick={() => act('pause', m.id)}
                      >
                        Pause
                      </button>
                    </>
                  ) : (
                    <button
                      type="button"
                      class="tm-btn-ghost"
                      disabled={busy}
                      onClick={() => act('resume', m.id)}
                    >
                      Resume
                    </button>
                  )}
                  <button
                    type="button"
                    class="tm-btn-ghost"
                    disabled={busy}
                    onClick={() => act('cancel', m.id)}
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    class="tm-btn-ghost"
                    disabled={busy}
                    onClick={() => act('delete', m.id)}
                  >
                    Delete
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}
      {message ? (
        <p class="tm-notice" role="status" data-testid="monitoring-status">
          {message}
        </p>
      ) : null}
    </>
  );
}
