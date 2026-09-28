import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';
import { extractItems, extractMainText, parsePrice } from '../src/extract.js';
import { ElementRegistry } from '../src/registry.js';

function dom(body: string) {
  const { window } = new JSDOM(`<!doctype html><html><head><title>T</title></head><body>${body}</body></html>`, {
    url: 'https://shop.fixture.test/search?q=x',
    pretendToBeVisual: true,
  });
  // jsdom has no layout: give every element a box so visibility checks pass.
  window.HTMLElement.prototype.getBoundingClientRect = function () {
    return { x: 10, y: 10, width: 200, height: 40, top: 10, left: 10, right: 210, bottom: 50, toJSON() {} } as DOMRect;
  };
  window.Element.prototype.checkVisibility = () => true;
  return window.document;
}

describe('parsePrice', () => {
  it('reads Indian and other currency formats', () => {
    expect(parsePrice('₹49,999')).toEqual({ amount: 49999, currency: 'INR' });
    expect(parsePrice('Rs. 1,29,900 only')).toEqual({ amount: 129900, currency: 'INR' });
    expect(parsePrice('INR 799')).toEqual({ amount: 799, currency: 'INR' });
    expect(parsePrice('₹1.2 lakh')).toEqual({ amount: 120000, currency: 'INR' });
    expect(parsePrice('₹45k')).toEqual({ amount: 45000, currency: 'INR' });
    expect(parsePrice('$12.50')).toEqual({ amount: 12.5, currency: 'USD' });
    expect(parsePrice('Model 2024, 16 GB RAM')).toBeNull();
  });
});

describe('extractItems — generic, no selectors', () => {
  it('grid of div cards: titles, prices (struck-through old price ignored), ratings, link ids', () => {
    const doc = dom(`<header><nav><a href="/">Home</a><a href="/cart">Cart</a></nav></header><main>
      <div class="grid">
        <div class="c"><a href="/p/1">Dell Inspiron 15</a><div><s>₹69,990</s> <span>₹58,990</span></div><span>4.1 ★</span></div>
        <div class="c"><a href="/p/2">HP 255 G9</a><div><del>₹44,000</del> ₹34,990</div><span>3.9 ★</span></div>
        <div class="c"><a href="/p/3">Lenovo IdeaPad Slim 3</a><div>₹45,490</div></div>
      </div>
      <aside><a href="/filters/brand">Brand</a></aside></main>`);
    const items = extractItems(doc, new ElementRegistry());
    expect(items.map((i) => [i.title, i.price, i.currency, i.rating])).toEqual([
      ['Dell Inspiron 15', 58990, 'INR', 4.1],
      ['HP 255 G9', 34990, 'INR', 3.9],
      ['Lenovo IdeaPad Slim 3', 45490, 'INR', null],
    ]);
    expect(items.every((i) => /^el-\d+$/.test(i.elementId))).toBe(true);
  });

  it('a list of result rows built differently (li, price before title)', () => {
    const doc = dom(`<main><ul>
      <li><span>Rs. 1,299</span><h3><a href="/item/9">Steel water bottle 1L</a></h3></li>
      <li><span>Rs. 899</span><h3><a href="/item/10">Insulated flask 500 ml</a></h3></li>
    </ul></main>`);
    const items = extractItems(doc, new ElementRegistry());
    expect(items.map((i) => [i.title, i.price])).toEqual([
      ['Steel water bottle 1L', 1299],
      ['Insulated flask 500 ml', 899],
    ]);
  });

  it('a card with an image link and a title link to the same product is one item', () => {
    const doc = dom(`<main><div class="grid">
      <div><a href="/p/7"><img alt=""></a><a href="/p/7">Boat Rockerz 450</a><b>₹1,499</b></div>
      <div><a href="/p/8"><img alt=""></a><a href="/p/8">JBL Tune 510BT</a><b>₹2,999</b></div>
    </div></main>`);
    expect(extractItems(doc, new ElementRegistry()).map((i) => [i.title, i.price])).toEqual([
      ['Boat Rockerz 450', 1499],
      ['JBL Tune 510BT', 2999],
    ]);
  });

  it('pages without prices return their result links (a search results page)', () => {
    const doc = dom(`<main><a href="/watch?v=1">Kannada songs jukebox</a><a href="/watch?v=2">Kannada hits 2024</a></main>`);
    expect(extractItems(doc, new ElementRegistry()).map((i) => [i.title, i.price])).toEqual([
      ['Kannada songs jukebox', null],
      ['Kannada hits 2024', null],
    ]);
  });
});

describe('extractMainText', () => {
  it('headings and paragraphs from main content, not page chrome', () => {
    const doc = dom(`<header><p>Sign in to get the best experience of our great site</p></header>
      <main><h1>Monsoon arrives</h1><p>The south-west monsoon reached Kerala three days early this year.</p>
      <ul><li>Farmers welcomed the early onset of the rains.</li></ul></main>
      <footer><p>Copyright notice and all the legal text you never read</p></footer>`);
    const t = extractMainText(doc);
    expect(t.headings).toEqual(['Monsoon arrives']);
    expect(t.paragraphs).toEqual([
      'The south-west monsoon reached Kerala three days early this year.',
      'Farmers welcomed the early onset of the rains.',
    ]);
  });
});
