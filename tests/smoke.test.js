/* The only automated gate this repo has. It exists because the two things most
 * likely to be quietly broken by a change are also the two hardest to eyeball:
 * sanitize(), which corrects structural mistakes the model makes reliably, and
 * the grouping that decides what a filter does to the screen.
 *
 * These assert the decisions CLAUDE.md says not to re-litigate. A failure here
 * is either a real regression or a decision being reversed on purpose — in
 * which case change the test and say why in the commit.
 *
 *   npm test
 */

import './dom-stub.js';
import {
  sanitize, menuGroups, dishPasses, availableDiets, priceBounds, filtersActive, state,
} from '../app.js';
import test from 'node:test';
import assert from 'node:assert/strict';

const dish = (original, extra = {}) => ({
  original, translated: '', ingredients: '', description: '', price: null,
  currency: 'EUR', vegetarian: false, glutenFree: false, ...extra,
});

const section = (name, items, extra = {}) =>
  ({ name, translation: '', note: '', items, ...extra });

/** menuGroups() and friends read module state, so every case sets all of it. */
function withMenu(menu, { diets = [], min = null, max = null, searching = false, query = '' } = {}) {
  state.menu = menu;
  state.filters = { diets: new Set(diets), min, max };
  state.searching = searching;
  state.query = query;
  return menuGroups();
}

const names = (groups) => groups.map((g) => ({
  id: g.id,
  header: g.header,
  dishes: g.sections.flatMap((s) => s.items.map((d) => d.original)),
}));

// ---------------------------------------------------------------- sanitize

test('sanitize strips dietary markers the prompt cannot reliably prevent', () => {
  const m = sanitize({ restaurantName: 'Osteria', sections: [
    section('ANTIPASTI', [dish('Bruschetta (v)'), dish('Insalata (gf)', { translated: 'Salad (v)' })]),
  ]});
  assert.equal(m.sections[0].items[0].original, 'Bruschetta');
  assert.equal(m.sections[0].items[1].original, 'Insalata');
  assert.equal(m.sections[0].items[1].translated, 'Salad');
});

test('sanitize leaves a name that is only a marker alone', () => {
  // Stripping would leave an empty name, which is worse than a stray marker.
  const m = sanitize({ restaurantName: '', sections: [section('ANTIPASTI', [dish('(v)')])] });
  assert.equal(m.sections[0].items[0].original, '(v)');
});

test('sanitize folds a run of one-dish sections into a single MENU', () => {
  const m = sanitize({ restaurantName: 'Osteria', sections: [
    section('Carbonara', [dish('Carbonara')]),
    section('Amatriciana', [dish('Amatriciana')]),
    section('DOLCI', [dish('Tiramisu')]),
  ]});
  assert.deepEqual(m.sections.map((s) => s.name), ['MENU', 'DOLCI']);
  assert.deepEqual(m.sections[0].items.map((d) => d.original), ['Carbonara', 'Amatriciana']);
});

test('sanitize replaces a heading that is really the restaurant name', () => {
  const m = sanitize({ restaurantName: 'Trattoria Vecchia', sections: [
    section('TRATTORIA VECCHIA', [dish('Carbonara'), dish('Cacio e pepe')], { translation: 'Main courses' }),
  ]});
  assert.equal(m.sections[0].name, 'MAIN COURSES');
});

test('sanitize falls back to MENU when the translation repeats the restaurant', () => {
  const m = sanitize({ restaurantName: 'Trattoria Vecchia', sections: [
    section('TRATTORIA VECCHIA', [dish('Carbonara')], { translation: 'Trattoria Vecchia' }),
  ]});
  assert.equal(m.sections[0].name, 'MENU');
  assert.equal(m.sections[0].translation, '');
});

test('sanitize merges neighbours left sharing a heading', () => {
  const m = sanitize({ restaurantName: 'Osteria', sections: [
    section('DOLCI', [dish('Tiramisu')]),
    section('dolci', [dish('Panna cotta')]),
  ]});
  assert.equal(m.sections.length, 1);
  assert.deepEqual(m.sections[0].items.map((d) => d.original), ['Tiramisu', 'Panna cotta']);
});

// ----------------------------------------------------------------- grouping

const MENU = () => ({ restaurantName: 'Trattoria', sections: [
  section('ANTIPASTI', [
    dish('Bruschetta', { price: 8, vegetarian: true }),
    dish('Insalata', { price: 12, vegetarian: true, glutenFree: true }),
  ]),
  section('PRIMI', [
    dish('Carbonara', { price: 18 }),
    dish('Risotto', { price: 22, glutenFree: true }),
  ]),
]});

test('no filters means one unheaded group holding the whole menu', () => {
  const g = names(withMenu(MENU()));
  assert.equal(g.length, 1);
  assert.equal(g[0].header, null);
  assert.deepEqual(g[0].dishes, ['Bruschetta', 'Insalata', 'Carbonara', 'Risotto']);
});

test('a filter sorts the menu, it never removes a dish', () => {
  const g = names(withMenu(MENU(), { diets: ['gf'] }));
  assert.deepEqual(g.map((x) => x.header), ['Fits your filters', 'Everything else']);
  assert.deepEqual(g[0].dishes, ['Insalata', 'Risotto']);
  assert.deepEqual(g[1].dishes, ['Bruschetta', 'Carbonara']);
  // Nothing was lost on the way.
  assert.equal(g[0].dishes.length + g[1].dishes.length, 4);
});

test('a filter matching nothing still leaves the reader the whole menu', () => {
  // The dead end this replaced: an empty screen with no hint of the cause.
  const menu = MENU();
  menu.sections.forEach((s) => s.items.forEach((d) => { d.glutenFree = false; }));
  const g = names(withMenu(menu, { diets: ['gf'] }));
  assert.equal(g[0].id, 'fits');
  assert.deepEqual(g[0].dishes, []);
  assert.deepEqual(g[1].dishes, ['Bruschetta', 'Insalata', 'Carbonara', 'Risotto']);
});

test('an empty "Everything else" is dropped but "Fits your filters" is not', () => {
  const menu = MENU();
  menu.sections.forEach((s) => s.items.forEach((d) => { d.glutenFree = true; }));
  const g = names(withMenu(menu, { diets: ['gf'] }));
  assert.deepEqual(g.map((x) => x.id), ['fits']);
});

test('search hides, because a query narrows where a preference sorts', () => {
  const g = names(withMenu(MENU(), { searching: true, query: 'risotto' }));
  assert.deepEqual(g[0].dishes, ['Risotto']);
});

test('search and filters compose: the query narrows, then the filter sorts', () => {
  // Risotto is gluten free and would be promoted, but it does not match the
  // query, so search removes it first. Narrowing beats sorting.
  const g = names(withMenu(MENU(), { diets: ['gf'], searching: true, query: 'a' }));
  assert.deepEqual(g[0].dishes, ['Insalata']);
  assert.deepEqual(g[1].dishes, ['Bruschetta', 'Carbonara']);
});

// ------------------------------------------------------------------ prices

test('a dish with no readable price survives a price filter', () => {
  // Hiding it would silently drop an item the menu does list.
  state.filters = { diets: new Set(), min: 10, max: 20 };
  assert.equal(dishPasses(dish('Sconosciuto', { price: null })), true);
  assert.equal(dishPasses(dish('Bruschetta', { price: 8 })), false);
  assert.equal(dishPasses(dish('Carbonara', { price: 18 })), true);
});

test('price bounds round outward, and are null when there is nothing to range over', () => {
  state.menu = MENU();
  assert.deepEqual(priceBounds(), { lo: 8, hi: 22 });

  state.menu = { restaurantName: '', sections: [section('S', [dish('One', { price: 9.5 })])] };
  assert.equal(priceBounds(), null, 'a single price is not a range');

  state.menu = { restaurantName: '', sections: [section('S', [
    dish('A', { price: 10 }), dish('B', { price: 10 })])] };
  assert.equal(priceBounds(), null, 'every price identical is not a range');
});

test('a price range left at the menu\'s own bounds is not an active filter', () => {
  // Otherwise "gluten free" quietly stores this menu's full range as a price
  // constraint, which then travels to the next menu.
  state.menu = MENU();
  state.filters = { diets: new Set(), min: 8, max: 22 };
  assert.equal(filtersActive(), false);
  state.filters = { diets: new Set(), min: 12, max: 22 };
  assert.equal(filtersActive(), true);
});

test('diet filters are only offered for badges the menu actually carries', () => {
  state.menu = MENU();
  assert.deepEqual(availableDiets(), [['gf', 'Gluten free'], ['veg', 'Vegetarian']]);

  state.menu = { restaurantName: '', sections: [section('S', [dish('Plain', { price: 5 })])] };
  assert.deepEqual(availableDiets(), []);
});
