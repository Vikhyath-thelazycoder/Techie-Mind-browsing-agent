import {
  Action,
  elementFingerprint,
  Origin,
  type ActionArgs,
  type DecisionSource,
  type DOMNode,
  type ExpectedOutcome,
  type Observation,
  type ProbeResponse,
} from '@techie-mind/contracts';

/**
 * Action binding (spec §11): the local runtime — never a model — turns a grounded target into an
 * executable Action tied to the task, observation, document, tab, origin, element and version.
 * The result is parsed by the `Action` contract, so an unbindable action cannot be produced.
 */
export interface BindInput {
  actionId: string;
  taskId: string;
  tabId: number;
  observation: Observation;
  target: DOMNode | null;
  args: ActionArgs;
  reason: string;
  confidence: number;
  expectedOutcome: ExpectedOutcome;
  proposedBy: DecisionSource;
  now: number;
}

export function bindAction(input: BindInput): Action {
  return Action.parse({
    actionId: input.actionId,
    binding: {
      taskId: input.taskId,
      observationId: input.observation.observationId,
      documentId: input.observation.documentId,
      tabId: input.tabId,
      origin: input.observation.origin,
      target: input.target
        ? {
            kind: 'element',
            elementId: input.target.nodeId,
            fingerprint: elementFingerprint(input.target.tag, input.target.role, input.target.name),
          }
        : null,
      observationVersion: input.observation.version,
    },
    args: input.args,
    reason: input.reason.slice(0, 500),
    confidence: input.confidence,
    expectedOutcome: input.expectedOutcome,
    proposedBy: input.proposedBy,
    createdAt: input.now,
  });
}

/**
 * NAVIGATE is bound to the tab's current state rather than to an element. When the tab shows no web
 * document (new tab page), origin is null — the Action contract allows that for NAVIGATE only.
 */
export function bindNavigation(input: {
  actionId: string;
  taskId: string;
  tabId: number;
  observationId: string;
  current: ProbeResponse | null;
  url: string;
  now: number;
}): Action {
  const origin =
    input.current && Origin.safeParse(input.current.origin).success ? input.current.origin : null;
  return Action.parse({
    actionId: input.actionId,
    binding: {
      taskId: input.taskId,
      observationId: input.observationId,
      documentId: input.current?.documentId ?? 'no-document',
      tabId: input.tabId,
      origin,
      target: null,
      observationVersion: input.current?.version ?? 0,
    },
    args: { type: 'NAVIGATE', url: input.url },
    reason: 'Direct navigation to the requested site',
    confidence: 1,
    expectedOutcome: { kind: 'url-changed', description: 'tab shows the requested site' },
    proposedBy: 'deterministic',
    createdAt: input.now,
  });
}
