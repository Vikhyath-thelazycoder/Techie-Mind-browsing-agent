/**
 * Stable per-document element ids. The same element keeps its id across observations, so an action
 * bound to "el-12" still refers to that exact node — or fails loudly if the node is gone.
 * WeakMap/WeakRef: the registry never keeps removed DOM alive.
 */
export class ElementRegistry {
  readonly #ids = new WeakMap<Element, string>();
  readonly #elements = new Map<string, WeakRef<Element>>();
  #next = 1;

  idFor(el: Element): string {
    let id = this.#ids.get(el);
    if (!id) {
      id = `el-${this.#next++}`;
      this.#ids.set(el, id);
      this.#elements.set(id, new WeakRef(el));
    }
    return id;
  }

  /** The live element for an id, or null if it was garbage-collected. */
  get(id: string): Element | null {
    return this.#elements.get(id)?.deref() ?? null;
  }

  /** Drop entries whose elements are gone (bounded memory on long-lived SPAs). */
  prune(): void {
    for (const [id, ref] of this.#elements) if (!ref.deref()) this.#elements.delete(id);
  }
}

/** Monotonic DOM version: increments once per batch of structural mutations. */
export class DomVersion {
  #version = 0;
  readonly #observer: MutationObserver;

  constructor(root: Node) {
    const Observer = root.ownerDocument?.defaultView?.MutationObserver ?? MutationObserver;
    this.#observer = new Observer((records) => {
      if (records.some((r) => r.type === 'childList' || r.type === 'characterData'))
        this.#version += 1;
    });
    this.#observer.observe(root, { childList: true, characterData: true, subtree: true });
  }

  get value(): number {
    return this.#version;
  }

  disconnect(): void {
    this.#observer.disconnect();
  }
}
