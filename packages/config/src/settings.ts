import { z } from 'zod';
import { Autonomy, Domain, Language, RiskLevel, WebUrl } from '@techie-mind/contracts';

function isLoopbackHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      (url.protocol === 'http:' || url.protocol === 'https:') &&
      ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
    );
  } catch {
    return false;
  }
}

/** Local services (Ollama, Laya adapter) must be loopback — they are never reached over the network. */
const LoopbackUrl = z.string().max(256).refine(isLoopbackHttpUrl, 'must be a loopback URL');

const HttpsUrl = WebUrl.refine((u) => u.startsWith('https://'), 'must be an https URL');

export const ModelProvider = z.enum(['ollama', 'openai-compatible']);
export type ModelProvider = z.infer<typeof ModelProvider>;

const ModelName = z.string().trim().max(128);

/**
 * ONE authoritative model configuration (master plan §22). Only the provider is selected; the model
 * id always comes from that provider's own record, so the UI label, runtime, router and request
 * payload cannot disagree. Everything reads it through `resolveActiveModel`.
 * API keys are deliberately NOT part of settings: credentials are held outside synced settings
 * (spec §65–66) and are introduced in Phase 3.
 */
export const ModelSettings = z.strictObject({
  activeProvider: ModelProvider,
  ollama: z.strictObject({ baseUrl: LoopbackUrl, model: ModelName }),
  openaiCompatible: z.strictObject({
    endpoint: HttpsUrl.nullable(),
    model: ModelName,
  }),
  laya: z.strictObject({
    enabled: z.boolean(),
    adapterUrl: LoopbackUrl,
    /**
     * Shared secret the local Laya adapter prints on first start. It only authenticates this
     * extension to a loopback process — it is not a provider credential and never leaves the machine.
     */
    token: z
      .string()
      .max(128)
      .regex(/^[A-Za-z0-9_-]*$/, 'letters, digits, _ and - only'),
  }),
});
export type ModelSettings = z.infer<typeof ModelSettings>;

export const PrivacySettings = z.strictObject({
  /** Privacy boundary. When on, sanitization fails closed. */
  enabled: z.boolean(),
  faceBlurring: z.boolean(),
  domPiiRedaction: z.boolean(),
  /** Aadhaar/PAN/UPI/IFSC/GSTIN/card redaction is unconditional (reference UI: "always on"). */
  indianIdentityFinancialRedaction: z.literal(true),
  tabGroupSandbox: z.boolean(),
  visionSpeedProfile: z.enum(['fast', 'balanced', 'accurate']),
});

export const AgentSettings = z.strictObject({
  autonomy: Autonomy,
  maxSteps: z.number().int().min(1).max(100),
  stepTimeoutMs: z.number().int().min(1_000).max(120_000),
  taskTimeoutMs: z.number().int().min(10_000).max(3_600_000),
  /** Actions at or above this risk level require explicit human confirmation. */
  confirmAtRisk: RiskLevel.exclude(['LOW']),
  /** Payment/OTP/bank authorization always hands over to the human (spec §24). Cannot be disabled. */
  financialSafety: z.literal(true),
  humanHandover: z.literal(true),
  domainAllowlist: z.array(Domain).max(500),
  domainBlocklist: z.array(Domain).max(500),
});

export const VoiceSettings = z.strictObject({
  sttEngine: z.enum(['web-speech']),
  ttsEnabled: z.boolean(),
  voicePersona: z.enum(['female-natural', 'male-natural', 'system-default']),
});

export const LanguageSettings = z.strictObject({
  uiLanguage: z.enum(['en']),
  preferredInputLanguage: Language,
});

export const MonitoringSettings = z.strictObject({
  apiUrl: HttpsUrl.nullable(),
});

export const NotificationSettings = z.strictObject({
  emailAlerts: z.boolean(),
});

export const ResearchSettings = z.strictObject({
  maxSitesPerQuery: z.number().int().min(1).max(20),
});

export const ExportSettings = z.strictObject({
  format: z.enum(['json', 'csv']),
  folder: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[A-Za-z0-9 _-]+$/, 'folder name only — no path separators'),
});

export const AdvancedSettings = z.strictObject({
  logLevel: z.enum(['debug', 'info', 'warn', 'error']),
  auditHashChain: z.boolean(),
});

/** Settings sections of spec §53 (GENERAL is represented by language/export/research). */
export const Settings = z.strictObject({
  schemaVersion: z.literal(1),
  model: ModelSettings,
  privacy: PrivacySettings,
  agent: AgentSettings,
  voice: VoiceSettings,
  language: LanguageSettings,
  monitoring: MonitoringSettings,
  notifications: NotificationSettings,
  research: ResearchSettings,
  export: ExportSettings,
  advanced: AdvancedSettings,
});
export type Settings = z.infer<typeof Settings>;

export const DEFAULT_SETTINGS: Settings = {
  schemaVersion: 1,
  model: {
    activeProvider: 'ollama',
    ollama: { baseUrl: 'http://127.0.0.1:11434', model: 'qwen2.5vl:7b' },
    openaiCompatible: { endpoint: null, model: '' },
    laya: { enabled: true, adapterUrl: 'http://127.0.0.1:8765', token: '' },
  },
  privacy: {
    enabled: true,
    faceBlurring: true,
    domPiiRedaction: true,
    indianIdentityFinancialRedaction: true,
    tabGroupSandbox: false,
    visionSpeedProfile: 'fast',
  },
  agent: {
    autonomy: 'ask-before-acting',
    maxSteps: 25,
    stepTimeoutMs: 30_000,
    taskTimeoutMs: 300_000,
    confirmAtRisk: 'HIGH',
    financialSafety: true,
    humanHandover: true,
    domainAllowlist: [],
    domainBlocklist: [],
  },
  voice: { sttEngine: 'web-speech', ttsEnabled: false, voicePersona: 'system-default' },
  language: { uiLanguage: 'en', preferredInputLanguage: 'en' },
  monitoring: { apiUrl: null },
  notifications: { emailAlerts: false },
  research: { maxSitesPerQuery: 6 },
  export: { format: 'json', folder: 'TechieMind' },
  advanced: { logLevel: 'info', auditHashChain: true },
};
