import { DERIVED_ATTR } from '@techie-mind/contracts';
import { describe, expect, it } from 'vitest';
import {
  groundResults,
  groundSearchInput,
  groundSearchSubmit,
  groundSearchToggle,
} from '../src/grounding.js';
import { link, node, observation, searchField } from './nodes.js';

describe('groundSearchInput', () => {
  it('prefers the real search box over newsletter, login and hidden decoys', () => {
    const real = searchField({ nodeId: 'real' });
    const obs = observation([
      node({
        tag: 'input',
        inputType: 'email',
        name: 'Email for newsletter',
        attributes: { autocomplete: 'email' },
      }),
      node({ tag: 'input', name: 'Username', attributes: { name: 'username' } }),
      node({ tag: 'input', name: 'Search', visible: false, bbox: null }),
      node({ tag: 'input', inputType: 'password', name: 'Password' }),
      real,
    ]);
    const ranked = groundSearchInput(obs);
    expect(ranked[0]?.node.nodeId).toBe('real');
    expect(ranked.map((c) => c.node.inputType)).not.toContain('email');
    expect(ranked.map((c) => c.node.inputType)).not.toContain('password');
  });

  it('grounds a plain text input by semantics alone (no type=search, no role)', () => {
    // Pattern used by many shops: <input type=text name=q placeholder="Search for products…"> in a form.
    const shop = node({
      nodeId: 'shop',
      tag: 'input',
      role: 'textbox',
      name: 'Search for Products, Brands and More',
      formId: 'f',
      attributes: {
        name: 'q',
        title: 'Search for Products, Brands and More',
        [DERIVED_ATTR.formAction]: '/search',
      },
    });
    const ranked = groundSearchInput(
      observation([
        node({ tag: 'input', name: 'Enter pincode', attributes: { name: 'pincode' } }),
        shop,
      ]),
    );
    expect(ranked[0]?.node.nodeId).toBe('shop');
    expect(ranked).toHaveLength(1);
  });

  it('grounds a combobox search (video-site pattern) in a banner', () => {
    const video = node({
      nodeId: 'video',
      tag: 'input',
      role: 'combobox',
      name: 'Search',
      attributes: {
        name: 'search_query',
        [DERIVED_ATTR.landmark]: 'banner',
        [DERIVED_ATTR.formAction]: '/results',
      },
    });
    expect(groundSearchInput(observation([video]))[0]?.node.nodeId).toBe('video');
  });

  it('returns nothing when the page has no search field', () => {
    const obs = observation([
      node({ tag: 'input', name: 'Full name' }),
      link('About us page', '/about'),
    ]);
    expect(groundSearchInput(obs)).toEqual([]);
  });
});

describe('groundSearchSubmit / groundSearchToggle', () => {
  it('finds the submit button of the same form and ignores clear/voice buttons', () => {
    const field = searchField({
      nodeId: 'field',
      formId: 'f1',
      bbox: { x: 100, y: 20, width: 400, height: 36 },
    });
    const submit = node({
      nodeId: 'submit',
      tag: 'button',
      role: 'button',
      name: 'Search',
      formId: 'f1',
      editable: false,
      bbox: { x: 505, y: 20, width: 40, height: 36 },
    });
    const voice = node({
      nodeId: 'voice',
      tag: 'button',
      role: 'button',
      name: 'Search with your voice',
      formId: 'f1',
      editable: false,
      bbox: { x: 550, y: 20, width: 40, height: 36 },
    });
    const ranked = groundSearchSubmit(observation([field, voice, submit]), field);
    expect(ranked[0]?.node.nodeId).toBe('submit');
    expect(ranked.map((c) => c.node.nodeId)).not.toContain('voice');
  });

  it('finds a collapsed-search toggle button', () => {
    const toggle = node({
      nodeId: 'toggle',
      tag: 'button',
      role: 'button',
      name: 'Open search',
      editable: false,
    });
    expect(
      groundSearchToggle(
        observation([
          node({ tag: 'button', role: 'button', name: 'Cart', editable: false }),
          toggle,
        ]),
      )[0]?.node.nodeId,
    ).toBe('toggle');
  });
});

describe('groundResults', () => {
  it('ranks content links by query-term overlap and ignores header/nav/footer links', () => {
    const obs = observation([
      link('Running shoes — all categories', '/c/shoes', 'navigation'),
      link('Help centre and returns', '/help', 'contentinfo'),
      link('Men’s trail running shoes, lightweight', '/p/1'),
      link('Kitchen knife set', '/p/2'),
      link('Running socks', '/p/3'),
    ]);
    const ranked = groundResults(obs, 'trail running shoes');
    expect(ranked.map((r) => r.node.attributes['href'])).toEqual(['/p/1', '/p/3']);
    expect(ranked[0]?.matchedTerms).toBe(3);
  });

  it('ignores fragment and javascript: links and very short labels', () => {
    const obs = observation([
      link('Kannada songs playlist', '#top'),
      // eslint-disable-next-line no-script-url -- hostile href under test: must be ignored
      link('Kannada songs player', 'javascript:void(0)'),
      link('Songs', '/s'),
    ]);
    expect(groundResults(obs, 'kannada songs')).toEqual([]);
  });
});
