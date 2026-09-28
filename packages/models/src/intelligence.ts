import { resolveActiveModel, type Settings } from '@techie-mind/config';
import {
  ModelRequest,
  ModelUsage,
  type IntentProfile,
  type LayaClassification,
  type ModelInterpretation,
  type ModelOutcome,
  type ModelTier,
  type SanitizedObservation,
  type VisualLocation,
} from '@techie-mind/contracts';
import type { RedactedImage } from '@techie-mind/privacy';
import { gatewayChat, hasModel, layaClassify, ollamaChat, ollamaModels } from './clients.js';
import {
  CATEGORIES,
  parseClassification,
  parseInterpretation,
  parseLocation,
  parseSummary,
  whyInvalid,
} from './parse.js';
import {
  INTERPRET_SCHEMA,
  INTERPRET_SYSTEM,
  interpretMessage,
  LOCATE_SCHEMA,
  LOCATE_SYSTEM,
  locateMessage,
  SUMMARIZE_SCHEMA,
  SUMMARIZE_SYSTEM,
} from './prompts.js';
import { describePage, summarizeForModel } from './summary.js';
import { TransportError, type ModelTransport } from './transport.js';

/** Tier budgets. Laya is a fast typed decision; a 7B model may need a moment on first load. */
export const LAYA_TIMEOUT_MS = 2_500;
export const MODEL_TIMEOUT_MS = 30_000;
export const HEALTH_TIMEOUT_MS = 1_500;
/** How long an availability answer is trusted before it is checked again. */
export const AVAILABILITY_TTL_MS = 60_000;

/** Facts about the open page Laya may use. Counts and a hostname only. */
export interface PageFacts {
  host: string;
  canSearch: boolean;
  resultCount: number;
}

export interface ClassifyInput {
  taskId: string;
  /** The user's request with personal data already replaced by vault tokens. */
  text: string;
  intent: IntentProfile;
  page: PageFacts | null;
}

export interface InterpretInput {
  taskId: string;
  text: string;
  intent: IntentProfile;
  /** The open page, sanitized locally (never a raw Observation). */
  observation: SanitizedObservation | null;
}

export interface LocateInput {
  taskId: string;
  /** What to find, in words (redacted like the request). */
  target: string;
  intent: IntentProfile;
  /** The visible tab after local redaction. */
  image: RedactedImage;
}

/** Vision reads screenshots slowly on first load; later calls are faster (model kept warm). */
export const VISION_TIMEOUT_MS = 45_000;

export interface TierAnswer<T> {
  usage: ModelUsage;
  value: T | null;
}

/**
 * The model tiers the agent core may consult (spec §21). Implementations never act: they return
 * typed, validated answers or nothing, with a usage record for every call.
 */
export interface Intelligence {
  readonly layaEnabled: boolean;
  /** Tier 1 — Laya typed decision. */
  classify(input: ClassifyInput): Promise<TierAnswer<LayaClassification>>;
  /** Tier 2/4 — the one active reasoning model (local Ollama or the configured gateway). */
  interpret(input: InterpretInput): Promise<TierAnswer<ModelInterpretation>>;
  /**
   * Tier 3 — local vision (Phase 4): where is the target in a redacted screenshot? Only a local
   * vision-capable model is used; a gateway never receives screenshots.
   */
  locate?(input: LocateInput): Promise<TierAnswer<VisualLocation>>;
  /**
   * Phase 5 — summarize a page from its redacted text blocks (carried as a SanitizedObservation).
   * Local model only: page text never goes to a remote gateway for a summary.
   */
  summarize?(input: SummarizeInput): Promise<TierAnswer<string>>;
}

export interface SummarizeInput {
  taskId: string;
  intent: IntentProfile;
  /** Headings and paragraphs, already redacted with the task vault, as sanitized nodes. */
  page: SanitizedObservation;
}

export interface IntelligenceDeps {
  settings: Settings;
  transport: ModelTransport;
  clock?: () => number;
  now?: () => number;
  newId?: (prefix: string) => string;
}

function outcomeOf(error: unknown): { outcome: ModelOutcome; reason: string } {
  if (error instanceof TransportError) {
    const outcome: ModelOutcome =
      error.kind === 'blocked'
        ? 'blocked'
        : error.kind === 'timeout'
          ? 'timeout'
          : error.kind === 'malformed'
            ? 'invalid'
            : 'unavailable';
    return { outcome, reason: error.message.slice(0, 500) };
  }
  return {
    outcome: 'unavailable',
    reason: (error instanceof Error ? error.message : String(error)).slice(0, 500),
  };
}

/** One reading of the request, as code understood it — shown to the model as a hint. */
function codeReading(intent: IntentProfile): string {
  return JSON.stringify({
    action: intent.action,
    query: intent.query,
    site: intent.targetDomain ?? intent.siteName,
    ordinal: intent.ordinal,
  });
}

export function createIntelligence(deps: IntelligenceDeps): Intelligence {
  const clock = deps.clock ?? (() => performance.now());
  const now = deps.now ?? Date.now;
  let seq = 0;
  const newId = deps.newId ?? ((prefix: string) => `${prefix}-${now()}-${++seq}`);
  const { laya } = deps.settings.model;
  const active = resolveActiveModel(deps.settings);
  const tier: ModelTier = active.local ? 'qwen' : 'api';
  let availability: { at: number; ok: boolean; reason: string } | null = null;

  const request = (
    taskId: string,
    reqTier: ModelTier,
    modelId: string,
    purpose: ModelRequest['purpose'],
    text: string,
    intent: IntentProfile,
    observation: SanitizedObservation | null,
  ) =>
    ModelRequest.parse({
      requestId: newId('mreq'),
      taskId,
      tier: reqTier,
      modelId,
      purpose,
      userGoal: text,
      intent,
      observation,
      createdAt: now(),
      sanitized: true,
    });

  const usage = (
    usageTier: ModelTier,
    modelId: string,
    purpose: ModelUsage['purpose'],
    outcome: ModelOutcome,
    started: number,
    reason: string | null,
  ) =>
    ModelUsage.parse({
      tier: usageTier,
      modelId: modelId || 'unset',
      purpose,
      outcome,
      latencyMs: Math.max(0, clock() - started),
      reason: reason ? reason.slice(0, 500) : null,
    });

  /** Is the configured model there? Checked, cached briefly, never substituted. */
  async function checkActive(): Promise<{ ok: boolean; reason: string }> {
    if (!active.configured || !active.endpoint) {
      return { ok: false, reason: `${active.label}: no model is configured` };
    }
    if (!active.local) return { ok: true, reason: '' };
    if (availability && now() - availability.at < AVAILABILITY_TTL_MS) return availability;
    try {
      const installed = await ollamaModels(deps.transport, active.endpoint, HEALTH_TIMEOUT_MS);
      availability = hasModel(installed, active.modelId)
        ? { at: now(), ok: true, reason: '' }
        : {
            at: now(),
            ok: false,
            reason: `${active.modelId} is not installed in Ollama (run: ollama pull ${active.modelId})`,
          };
    } catch (error) {
      availability = { at: now(), ok: false, reason: `Ollama: ${outcomeOf(error).reason}` };
    }
    return availability;
  }

  return {
    layaEnabled: laya.enabled,

    async classify(input) {
      const started = clock();
      const modelId = 'laya-mlx';
      if (!laya.enabled) {
        return {
          usage: usage('laya', modelId, 'classify-intent', 'unavailable', started, 'disabled'),
          value: null,
        };
      }
      try {
        const req = request(
          input.taskId,
          'laya',
          modelId,
          'classify-intent',
          input.text,
          input.intent,
          null,
        );
        const raw = await layaClassify(
          deps.transport,
          laya.adapterUrl,
          laya.token,
          req,
          { text: input.text, page: input.page, choices: CATEGORIES },
          LAYA_TIMEOUT_MS,
        );
        const value = parseClassification(raw);
        if (!value) {
          return {
            usage: usage(
              'laya',
              modelId,
              'classify-intent',
              'invalid',
              started,
              'not a typed answer',
            ),
            value: null,
          };
        }
        return {
          usage: usage(
            'laya',
            modelId,
            'classify-intent',
            value.escalate ? 'escalated' : 'answered',
            started,
            `${value.category} ${value.confidence.toFixed(2)}`,
          ),
          value,
        };
      } catch (error) {
        const { outcome, reason } = outcomeOf(error);
        return {
          usage: usage('laya', modelId, 'classify-intent', outcome, started, reason),
          value: null,
        };
      }
    },

    async interpret(input) {
      const started = clock();
      const modelId = active.modelId;
      const check = await checkActive();
      if (!check.ok) {
        return {
          usage: usage(tier, modelId, 'plan-action', 'unavailable', started, check.reason),
          value: null,
        };
      }
      try {
        const page = input.observation ? summarizeForModel(input.observation) : null;
        const req = request(
          input.taskId,
          tier,
          modelId,
          'plan-action',
          input.text,
          input.intent,
          page,
        );
        const call = {
          request: req,
          model: modelId,
          system: INTERPRET_SYSTEM,
          user: interpretMessage(input.text, describePage(page), codeReading(input.intent)),
          schema: INTERPRET_SCHEMA,
          timeoutMs: MODEL_TIMEOUT_MS,
        };
        const content = active.local
          ? await ollamaChat(deps.transport, active.endpoint!, call)
          : await gatewayChat(deps.transport, active.endpoint!, call);
        const value = parseInterpretation(content);
        if (!value) {
          return {
            usage: usage(
              tier,
              modelId,
              'plan-action',
              'invalid',
              started,
              `answer is not the required JSON (${whyInvalid(content) ?? 'unreadable'})`,
            ),
            value: null,
          };
        }
        return {
          usage: usage(
            tier,
            modelId,
            'plan-action',
            value.kind === 'abstain' ? 'abstained' : 'answered',
            started,
            value.kind === 'abstain'
              ? value.reason
              : `${value.kind} ${value.confidence.toFixed(2)}`,
          ),
          value,
        };
      } catch (error) {
        const { outcome, reason } = outcomeOf(error);
        return {
          usage: usage(tier, modelId, 'plan-action', outcome, started, reason),
          value: null,
        };
      }
    },

    async summarize(input) {
      const started = clock();
      const modelId = active.modelId;
      if (!active.local) {
        return {
          usage: usage(
            tier,
            modelId,
            'plan-action',
            'unavailable',
            started,
            'summaries run only on the local model',
          ),
          value: null,
        };
      }
      const check = await checkActive();
      if (!check.ok) {
        return {
          usage: usage(tier, modelId, 'plan-action', 'unavailable', started, check.reason),
          value: null,
        };
      }
      try {
        const req = request(
          input.taskId,
          tier,
          modelId,
          'summarize',
          'summarize this page',
          input.intent,
          input.page,
        );
        const text = input.page.nodes
          .map((n) => `${n.role === 'heading' ? '## ' : ''}${n.text ?? n.name ?? ''}`)
          .join('\n')
          .slice(0, 12_000);
        const content = await ollamaChat(deps.transport, active.endpoint!, {
          request: req,
          model: modelId,
          system: SUMMARIZE_SYSTEM,
          user: `Page: ${input.page.origin}${input.page.path}\nTitle: ${input.page.title}\n\n${text}`,
          schema: SUMMARIZE_SCHEMA,
          timeoutMs: MODEL_TIMEOUT_MS,
        });
        const value = parseSummary(content);
        return {
          usage: usage(
            tier,
            modelId,
            'plan-action',
            value ? 'answered' : 'invalid',
            started,
            value ? 'summary' : 'not a summary',
          ),
          value,
        };
      } catch (error) {
        const { outcome, reason } = outcomeOf(error);
        return {
          usage: usage(tier, modelId, 'plan-action', outcome, started, reason),
          value: null,
        };
      }
    },

    async locate(input) {
      const started = clock();
      const modelId = deps.settings.model.ollama.model;
      if (!active.local) {
        // Screenshots never go to a remote gateway, even redacted.
        return {
          usage: usage(
            'vision',
            modelId,
            'visual-grounding',
            'unavailable',
            started,
            'vision runs only on the local model',
          ),
          value: null,
        };
      }
      const check = await checkActive();
      if (!check.ok) {
        return {
          usage: usage('vision', modelId, 'visual-grounding', 'unavailable', started, check.reason),
          value: null,
        };
      }
      try {
        const req = request(
          input.taskId,
          'vision',
          modelId,
          'visual-grounding',
          input.target,
          input.intent,
          null,
        );
        const content = await ollamaChat(deps.transport, active.endpoint!, {
          request: req,
          model: modelId,
          system: LOCATE_SYSTEM,
          user: locateMessage(input.target, input.image.width, input.image.height),
          schema: LOCATE_SCHEMA,
          images: [input.image],
          timeoutMs: VISION_TIMEOUT_MS,
        });
        const value = parseLocation(content, input.image.width, input.image.height);
        if (!value) {
          return {
            usage: usage(
              'vision',
              modelId,
              'visual-grounding',
              'invalid',
              started,
              'not a box inside the image',
            ),
            value: null,
          };
        }
        return {
          usage: usage(
            'vision',
            modelId,
            'visual-grounding',
            value.found ? 'answered' : 'abstained',
            started,
            value.found ? `box ${value.confidence.toFixed(2)}` : value.reason,
          ),
          value,
        };
      } catch (error) {
        const { outcome, reason } = outcomeOf(error);
        return {
          usage: usage('vision', modelId, 'visual-grounding', outcome, started, reason),
          value: null,
        };
      }
    },
  };
}
