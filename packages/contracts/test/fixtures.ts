import type {
  Action,
  ActionBinding,
  Observation,
  SanitizedObservation,
  Task,
} from '../src/index.js';

export const NOW = 1_790_000_000_000;

export function binding(overrides: Partial<ActionBinding> = {}): ActionBinding {
  return {
    taskId: 'task-1',
    observationId: 'obs-1',
    documentId: 'doc-1',
    tabId: 7,
    origin: 'https://www.youtube.com',
    target: { kind: 'element', elementId: 'el-12', fingerprint: 'input|searchbox|search' },
    observationVersion: 3,
    ...overrides,
  };
}

export function action(overrides: Partial<Action> = {}): Action {
  return {
    actionId: 'act-1',
    binding: binding(),
    args: { type: 'TYPE', input: { text: 'python tutorials' }, submit: true },
    reason: 'Enter the search query',
    confidence: 0.97,
    expectedOutcome: { kind: 'result-set-changed', description: 'search results render' },
    proposedBy: 'deterministic',
    createdAt: NOW,
    ...overrides,
  };
}

export function task(overrides: Partial<Task> = {}): Task {
  return {
    taskId: 'task-1',
    text: 'Open YouTube and search for Python tutorials',
    source: 'typed',
    mode: 'search',
    autonomy: 'act-without-asking',
    language: 'en',
    status: 'PENDING',
    createdAt: NOW,
    maxSteps: 20,
    skillId: null,
    ...overrides,
  };
}

export function observation(overrides: Partial<Observation> = {}): Observation {
  return {
    observationId: 'obs-1',
    taskId: 'task-1',
    tabId: 7,
    documentId: 'doc-1',
    origin: 'https://www.youtube.com',
    url: 'https://www.youtube.com/',
    title: 'YouTube',
    version: 3,
    createdAt: NOW,
    viewport: { width: 1280, height: 800, scrollX: 0, scrollY: 0, devicePixelRatio: 2 },
    domNodes: [
      {
        nodeId: 'el-12',
        parentId: null,
        tag: 'input',
        role: 'searchbox',
        name: 'Search',
        text: null,
        attributes: { name: 'search_query' },
        inputType: 'text',
        formId: 'el-2',
        value: '',
        visible: true,
        interactive: true,
        editable: true,
        bbox: { x: 400, y: 12, width: 500, height: 40 },
      },
    ],
    a11yNodes: [
      {
        nodeId: 'ax-1',
        domNodeId: 'el-12',
        role: 'searchbox',
        name: 'Search',
        value: null,
        states: ['focusable'],
        childIds: [],
      },
    ],
    visualRegions: [],
    ...overrides,
  };
}

export function sanitizedObservation(
  overrides: Partial<SanitizedObservation> = {},
): SanitizedObservation {
  return {
    observationId: 'obs-1',
    version: 3,
    origin: 'https://www.youtube.com',
    path: '/',
    title: 'YouTube',
    createdAt: NOW,
    nodes: [
      {
        nodeId: 'el-12',
        role: 'searchbox',
        name: 'Search',
        text: null,
        interactive: true,
        editable: true,
        bbox: null,
      },
    ],
    findings: [],
    redactionCount: 0,
    sanitized: true,
    ...overrides,
  };
}
