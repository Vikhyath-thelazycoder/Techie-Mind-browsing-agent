import { DERIVED_ATTR, type DOMNode, type Observation } from '@techie-mind/contracts';

let counter = 0;

/** Build a DOMNode with sensible defaults for grounding tests. */
export function node(partial: Partial<DOMNode> & { tag: string }): DOMNode {
  counter += 1;
  const editable = partial.editable ?? (partial.tag === 'input' || partial.tag === 'textarea');
  return {
    nodeId: partial.nodeId ?? `el-${counter}`,
    parentId: null,
    role: partial.role ?? null,
    name: partial.name ?? null,
    text: partial.text ?? null,
    attributes: partial.attributes ?? {},
    inputType: partial.inputType ?? (partial.tag === 'input' ? 'text' : null),
    formId: partial.formId ?? null,
    value: partial.value ?? (editable ? '' : null),
    visible: partial.visible ?? true,
    interactive: partial.interactive ?? true,
    editable,
    bbox:
      partial.bbox === undefined
        ? { x: 100, y: 20 + counter, width: 400, height: 36 }
        : partial.bbox,
    ...partial,
  };
}

export function searchField(extra: Partial<DOMNode> = {}): DOMNode {
  return node({
    tag: 'input',
    role: 'searchbox',
    inputType: 'search',
    name: 'Search',
    formId: 'form-1',
    attributes: { name: 'q', placeholder: 'Search', [DERIVED_ATTR.formAction]: '/search' },
    ...extra,
  });
}

export function link(
  label: string,
  href: string,
  landmark = 'main',
  extra: Partial<DOMNode> = {},
): DOMNode {
  return node({
    tag: 'a',
    role: 'link',
    name: label,
    text: label,
    editable: false,
    attributes: { href, [DERIVED_ATTR.landmark]: landmark },
    ...extra,
  });
}

export function observation(domNodes: DOMNode[], extra: Partial<Observation> = {}): Observation {
  return {
    observationId: 'obs-1',
    taskId: 'task-1',
    tabId: 1,
    documentId: 'doc-1',
    origin: 'https://site.test',
    url: 'https://site.test/',
    title: 'Site',
    version: 1,
    createdAt: 0,
    viewport: { width: 1280, height: 800, scrollX: 0, scrollY: 0, devicePixelRatio: 1 },
    domNodes,
    a11yNodes: [],
    visualRegions: [],
    ...extra,
  };
}
