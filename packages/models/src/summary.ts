import { SanitizedObservation, type SanitizedNode } from '@techie-mind/contracts';

/** Most elements a model is shown: small prompts are fast prompts (plan §42). */
export const SUMMARY_MAX_NODES = 60;
const LINE_MAX = 120;

function label(node: SanitizedNode): string {
  return (node.name ?? node.text ?? '').replace(/\s+/g, ' ').trim();
}

/**
 * The page as a model sees it: a SanitizedObservation (already redacted and tokenized locally)
 * trimmed to the visible, named, interactive elements nearest the top, plus a few headings.
 * No field values, no query string, no findings detail — only what is needed to pick an element.
 */
export function summarizeForModel(
  obs: SanitizedObservation,
  max = SUMMARY_MAX_NODES,
): SanitizedObservation {
  const seen = new Set<string>();
  const top = (n: SanitizedNode) => n.bbox?.y ?? Number.MAX_SAFE_INTEGER;
  const named = obs.nodes.filter((n) => {
    const text = label(n);
    return text.length > 0 && (n.bbox === null || (n.bbox.width > 0 && n.bbox.height > 0));
  });
  const headings = named.filter((n) => n.role === 'heading').slice(0, 5);
  const interactive = named
    .filter((n) => n.interactive && n.role !== 'heading')
    .sort((a, b) => top(a) - top(b))
    .filter((n) => {
      const key = `${n.role}|${label(n).toLowerCase()}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, Math.max(0, max - headings.length));
  const keep = new Set([...headings, ...interactive].map((n) => n.nodeId));
  return SanitizedObservation.parse({
    ...obs,
    nodes: obs.nodes
      .filter((n) => keep.has(n.nodeId))
      .map((n) => ({
        ...n,
        name: n.name ? n.name.slice(0, LINE_MAX) : null,
        text: n.text ? n.text.slice(0, LINE_MAX) : null,
      })),
    findings: [],
  });
}

/** One line per element: `el-12 | link | Samsung Galaxy S24 (Black, 128 GB)`. */
export function describePage(obs: SanitizedObservation | null): string {
  if (!obs) return 'No web page is open.';
  const lines = obs.nodes.map((n) => `${n.nodeId} | ${n.role ?? 'element'} | ${label(n)}`);
  return [
    `Page: ${obs.origin}${obs.path}`,
    `Title: ${obs.title}`,
    `Elements (${lines.length}):`,
    ...lines,
  ].join('\n');
}
