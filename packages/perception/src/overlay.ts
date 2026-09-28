/**
 * Visible agent activity (spec §27): a ring and label drawn around the element the agent is about
 * to act on. It is only ever shown for a real action on that real element — never simulated.
 * Built with DOM APIs in a closed shadow root (no HTML strings), pointer-events disabled.
 */
export class ActivityOverlay {
  #host: HTMLElement | null = null;
  #ring: HTMLElement | null = null;
  #label: HTMLElement | null = null;
  #timer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly doc: Document) {}

  #ensure(): void {
    if (this.#host?.isConnected) return;
    const host = this.doc.createElement('techie-mind-activity');
    host.style.cssText =
      'all:initial;position:fixed;inset:0;pointer-events:none;z-index:2147483647;';
    const root = host.attachShadow({ mode: 'closed' });
    const ring = this.doc.createElement('div');
    ring.style.cssText =
      'position:fixed;border:2px solid #b23a2a;border-radius:8px;box-shadow:0 0 0 4px rgba(178,58,42,.18);transition:all .12s ease;display:none;';
    const label = this.doc.createElement('div');
    label.style.cssText =
      'position:fixed;padding:3px 8px;border-radius:6px;background:#b23a2a;color:#fff;font:600 12px -apple-system,Segoe UI,sans-serif;display:none;white-space:nowrap;';
    root.append(ring, label);
    this.doc.documentElement.append(host);
    this.#host = host;
    this.#ring = ring;
    this.#label = label;
  }

  show(el: Element, text: string, durationMs = 1_200): void {
    this.#ensure();
    const rect = el.getBoundingClientRect();
    if (!this.#ring || !this.#label) return;
    Object.assign(this.#ring.style, {
      display: 'block',
      left: `${rect.left - 4}px`,
      top: `${rect.top - 4}px`,
      width: `${rect.width + 8}px`,
      height: `${rect.height + 8}px`,
    });
    this.#label.textContent = `Techie Mind · ${text}`;
    Object.assign(this.#label.style, {
      display: 'block',
      left: `${Math.max(4, rect.left)}px`,
      top: `${Math.max(4, rect.top - 26)}px`,
    });
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = setTimeout(() => this.hide(), durationMs);
  }

  hide(): void {
    if (this.#ring) this.#ring.style.display = 'none';
    if (this.#label) this.#label.style.display = 'none';
  }
}
