import { JSDOM } from 'jsdom';
import { ActivityOverlay, DomVersion, ElementRegistry, type PageContext } from '../src/index.js';

/**
 * JSDOM has no layout engine. Give every element a deterministic box so visibility/geometry logic
 * runs; elements with `hidden`, `display:none` or data-zero-size get an empty box.
 */
export function makePage(
  html: string,
  url = 'https://shop.example.test/',
): { dom: JSDOM; ctx: PageContext } {
  const dom = new JSDOM(
    `<!doctype html><html><head><title>Fixture</title></head><body>${html}</body></html>`,
    {
      url,
      pretendToBeVisual: true,
    },
  );
  const win = dom.window;
  let order = 0;
  const boxes = new WeakMap<Element, number>();
  win.Element.prototype.getBoundingClientRect = function (this: Element) {
    const style = win.getComputedStyle(this);
    const hiddenByAncestor = this.closest('[hidden],[data-zero-size]') !== null;
    if (hiddenByAncestor || style.display === 'none' || style.visibility === 'hidden') {
      return {
        x: 0,
        y: 0,
        width: 0,
        height: 0,
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        toJSON() {},
      } as DOMRect;
    }
    if (!boxes.has(this)) boxes.set(this, order++);
    const y = 10 + (boxes.get(this) ?? 0) * 40;
    return {
      x: 20,
      y,
      width: 300,
      height: 32,
      top: y,
      left: 20,
      right: 320,
      bottom: y + 32,
      toJSON() {},
    } as DOMRect;
  };
  // JSDOM does not implement scrolling.
  win.Element.prototype.scrollIntoView = () => {};
  const doc = win.document;
  const ctx: PageContext = {
    doc,
    documentId: 'doc-test',
    registry: new ElementRegistry(),
    version: new DomVersion(doc.documentElement),
    overlay: new ActivityOverlay(doc),
  };
  return { dom, ctx };
}
