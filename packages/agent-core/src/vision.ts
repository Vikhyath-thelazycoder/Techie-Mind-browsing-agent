import type { BoundingBox, DOMNode, Observation } from '@techie-mind/contracts';

/**
 * Perception level 4 (spec §11–12, plan §15–16): vision is a fallback, never the first look.
 * It is worth trying only when semantic grounding found nothing AND the page has things only a
 * picture can describe — controls without an accessible name, images, canvas. On a text-only page
 * that grounding could not match, a screenshot adds nothing, so vision is not run.
 */

const VISUAL_TAGS = new Set(['img', 'canvas', 'svg', 'picture', 'video']);

/** Visible elements whose meaning is visual: unnamed controls, images, canvas. */
export function visualOnlyElements(obs: Observation): number {
  return obs.domNodes.filter(
    (n) =>
      n.visible &&
      ((n.interactive && !(n.name ?? '').trim() && !(n.text ?? '').trim()) ||
        VISUAL_TAGS.has(n.tag)),
  ).length;
}

export function visionWorthTrying(obs: Observation): boolean {
  return visualOnlyElements(obs) > 0;
}

/** A capture's geometry: image pixels per CSS pixel and where the viewport was scrolled. */
export interface CaptureGeometry {
  scale: number;
  scrollX: number;
  scrollY: number;
}

/** Image-pixel box → page CSS box (the coordinate space of DOMNode.bbox). */
export function regionToPage(
  box: readonly [number, number, number, number],
  capture: CaptureGeometry,
): BoundingBox {
  const [x1, y1, x2, y2] = box;
  return {
    x: x1 / capture.scale + capture.scrollX,
    y: y1 / capture.scale + capture.scrollY,
    width: (x2 - x1) / capture.scale,
    height: (y2 - y1) / capture.scale,
  };
}

function area(b: BoundingBox): number {
  return Math.max(0, b.width) * Math.max(0, b.height);
}

function intersection(a: BoundingBox, b: BoundingBox): number {
  const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
}

function contains(b: BoundingBox, x: number, y: number): boolean {
  return x >= b.x && x <= b.x + b.width && y >= b.y && y <= b.y + b.height;
}

export interface RegionMatch {
  node: DOMNode;
  /** Share of the element inside the region (0..1). */
  overlap: number;
  centerInside: boolean;
}

/**
 * Ground a visual region back to ONE visible interactive DOM element — the action is then bound to
 * that element and checked by the firewall like any other. No element → null (hand over): the
 * agent never clicks raw coordinates.
 */
export function groundRegion(region: BoundingBox, obs: Observation): RegionMatch | null {
  const cx = region.x + region.width / 2;
  const cy = region.y + region.height / 2;
  let best: (RegionMatch & { score: number }) | null = null;
  for (const node of obs.domNodes) {
    if (!node.visible || !node.interactive || !node.bbox || area(node.bbox) === 0) continue;
    const overlap = intersection(region, node.bbox) / area(node.bbox);
    const centerInside = contains(node.bbox, cx, cy);
    if (!centerInside && overlap < 0.5) continue;
    // Prefer elements the region covers well; among those, the tightest one (a card's link, not
    // the whole page wrapper).
    const tight = Math.min(1, area(region) / area(node.bbox));
    const score = overlap + (centerInside ? 0.5 : 0) + tight * 0.5;
    if (!best || score > best.score) best = { node, overlap, centerInside, score };
  }
  return best ? { node: best.node, overlap: best.overlap, centerInside: best.centerInside } : null;
}
