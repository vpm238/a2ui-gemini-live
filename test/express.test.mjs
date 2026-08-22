import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { parseExpress } from '../src/express/parse.js';
import { transpile, expansion } from '../src/express/transpile.js';
import { brief } from '../src/render/gates.js';
import { Session } from '../src/session.js';
import { systemInstruction, functionDeclarations } from '../src/express/prompt.js';

const catalog = JSON.parse(readFileSync(new URL('../catalog/travel.catalog.json', import.meta.url), 'utf8'));

const FLIGHTS = `heading Lisbon · Fri 14 – Sun 16
cards pick_flight
- TAP Air Portugal | 06:15–09:05 | EUR 189 | direct
- easyJet | 11:40–14:25 | EUR 212 | direct
- Ryanair | 19:05–21:50 | EUR 244 | 1 stop
note Prices held for 20 minutes`;

const messagesOf = (src) => {
  const ir = parseExpress(src, catalog);
  assert.deepEqual(ir.errors, [], `unexpected parse errors for:\n${src}`);
  return transpile(ir, catalog);
};

// ------------------------------------------------------------------ parsing

test('parses a list surface', () => {
  const ir = parseExpress(FLIGHTS, catalog);
  assert.deepEqual(ir.errors, []);
  assert.equal(ir.surfaceId, 'main');
  assert.deepEqual(ir.nodes.map((n) => n.component), ['Heading', 'OptionCards', 'Status']);
  assert.equal(ir.nodes[1].items.length, 3);
  assert.deepEqual(ir.nodes[1].items[1], {
    title: 'easyJet', when: '11:40–14:25', price: 'EUR 212', tag: 'direct',
  });
});

test('both catalog examples parse', () => {
  for (const example of catalog.examples) {
    const ir = parseExpress(example.express, catalog);
    assert.deepEqual(ir.errors, [], `catalog example failed:\n${example.express}`);
  }
});

test('a text head takes the rest of the line verbatim, pipes included', () => {
  const ir = parseExpress('heading Lisbon | Porto | Faro', catalog);
  assert.deepEqual(ir.errors, []);
  assert.equal(ir.nodes[0].head.text, 'Lisbon | Porto | Faro');
});

test('surface names the surface and must come first', () => {
  assert.equal(parseExpress('surface flights\nheading Hi', catalog).surfaceId, 'flights');
  const late = parseExpress('heading Hi\nsurface flights', catalog);
  assert.match(late.errors[0].message, /must come first/);
});

test('blank lines and comments are ignored', () => {
  const ir = parseExpress('\n# a comment\nheading Hi\n\n', catalog);
  assert.deepEqual(ir.errors, []);
  assert.equal(ir.nodes.length, 1);
});

test('a trailing pipe is forgiven', () => {
  const ir = parseExpress('cards pick_flight\n- TAP | 06:15 | EUR 189 | direct |', catalog);
  assert.deepEqual(ir.errors, []);
  assert.equal(ir.nodes[0].items[0].tag, 'direct');
});

// ------------------------------------------------------------------- errors

test('an unknown keyword names the ones that exist', () => {
  const { errors } = parseExpress('carousel pick_flight', catalog);
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /"carousel" is not a component/);
  assert.match(errors[0].hint, /cards/);
  assert.equal(errors[0].line, 1);
});

test('a wrong field count says what the fields are', () => {
  const { errors } = parseExpress('cards pick_flight\n- TAP | 06:15', catalog);
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /expected 4 fields, found 2/);
  assert.match(errors[0].hint, /title \| when \| price \| tag/);
  assert.equal(errors[0].line, 2);
});

test('an orphan item line is caught', () => {
  const { errors } = parseExpress('- TAP | 06:15 | EUR 189 | direct', catalog);
  assert.match(errors[0].message, /no list above it/);
});

test('an empty list is caught', () => {
  const { errors } = parseExpress('cards pick_flight\nnote done', catalog);
  assert.match(errors[0].message, /has no items/);
});

test('every error in the file is reported, not just the first', () => {
  const { errors } = parseExpress('carousel x\ncards pick_flight\n- TAP | 06:15\n- easyJet | a | b | c', catalog);
  assert.equal(errors.length, 2);
  assert.deepEqual(errors.map((e) => e.line), [1, 3]);
});

test('a duplicate action name is caught', () => {
  const src = 'cards pick_flight\n- A | 1 | 2 | 3\ncards pick_flight\n- B | 1 | 2 | 3';
  const { errors } = parseExpress(src, catalog);
  assert.match(errors[0].message, /used twice/);
});

test('a bad action name is caught', () => {
  const { errors } = parseExpress('cards Pick-Flight\n- A | 1 | 2 | 3', catalog);
  assert.match(errors[0].message, /not a valid action name/);
});

test('extra head words are caught', () => {
  const { errors } = parseExpress('cards pick_flight now\n- A | 1 | 2 | 3', catalog);
  assert.match(errors[0].message, /unexpected `now`/);
});

test('a list component given inline fields is redirected to item lines', () => {
  const { errors } = parseExpress('cards pick_flight | TAP | 06:15 | EUR 189 | direct', catalog);
  assert.match(errors[0].message, /takes its values on following/);
});

test('empty source is an error, not an empty surface', () => {
  assert.match(parseExpress('   \n\n', catalog).errors[0].message, /nothing to render/);
});

// -------------------------------------------------------------- transpiling

test('one Express line becomes a complete, bound A2UI surface', () => {
  const { messages, components, dataModel, surfaceId } = messagesOf(FLIGHTS);

  assert.equal(surfaceId, 'main');
  assert.deepEqual(messages.map((m) => Object.keys(m)[0]),
    ['createSurface', 'updateDataModel', 'updateComponents']);
  assert.equal(messages[0].createSurface.catalogUri, catalog.catalogId);

  const root = components[0];
  assert.equal(root.component, 'Column');
  assert.deepEqual(root.children, ['heading1', 'pick_flight', 'note1']);

  const cards = components.find((c) => c.id === 'pick_flight');
  assert.deepEqual(cards.items, { path: '/pick_flight/items' });
  assert.equal(cards.selectionPath, '/pick_flight/selected');
  assert.deepEqual(cards.action, { name: 'pick_flight', contextFields: ['index', 'title'] });
  assert.deepEqual(cards.modality, { requiresVisual: false, stakes: 'none', spokenSensitive: false });

  assert.equal(dataModel.pick_flight.items.length, 3);
  assert.equal(dataModel.pick_flight.selected, null);
});

test('a single-value component carries its fields as properties', () => {
  const { components } = messagesOf('confirm pay_now | easyJet · Fri 11:40 | EUR 212.00 | Visa ending 4417');
  const confirm = components.find((c) => c.id === 'pay_now');
  assert.equal(confirm.summary, 'easyJet · Fri 11:40');
  assert.equal(confirm.amount, 'EUR 212.00');
  assert.equal(confirm.method, 'Visa ending 4417');
  assert.equal(confirm.modality.stakes, 'readback');
  assert.equal(confirm.items, undefined);
});

test('components without an action get counted ids', () => {
  const { components } = messagesOf('heading One\nheading Two');
  assert.deepEqual(components.slice(1).map((c) => c.id), ['heading1', 'heading2']);
});

test('Express is much smaller than the protocol it produces', () => {
  const { messages } = messagesOf(FLIGHTS);
  const { from, to, ratio } = expansion(FLIGHTS, messages);
  assert.ok(to > from * 2, `expected real expansion, got ${from}→${to}`);
  assert.ok(ratio > 2);
});

// ------------------------------------------------------------------- gates

test('the briefing numbers the options the way the user will count them', () => {
  const surface = messagesOf(FLIGHTS);
  const { notes, options } = brief(surface, catalog);
  assert.deepEqual(options, { pick_flight: 3 });
  const numbering = notes.find((n) => n.includes('numbered'));
  assert.match(numbering, /1 TAP Air Portugal, 06:15–09:05, EUR 189/);
  assert.match(numbering, /2 easyJet/);
  // `tag` is not in the catalog's speech template, so it is not read out.
  assert.doesNotMatch(numbering, /direct/);
});

test('a readback names the fields that may be spoken and the ones that may not', () => {
  const surface = messagesOf('confirm pay_now | easyJet · Fri 11:40 | EUR 212.00 | Visa ending 4417');
  const { stakes, notes } = brief(surface, catalog);
  assert.equal(stakes, 'readback');
  const note = notes.find((n) => n.includes('commits money'));
  assert.match(note, /Read back summary and amount/);
  assert.match(note, /Do not say method aloud/);
});

test('a visual-only component tells the model not to describe it', () => {
  const surface = messagesOf('seatmap choose_seat\n- 14A | window | EUR 12');
  const note = brief(surface, catalog).notes.find((n) => n.includes('cannot be conveyed'));
  assert.match(note, /look at the screen/);
});

test('a spokenSensitive component is never enumerated in the briefing', () => {
  const surface = messagesOf('private\n- Passport | PT 4417 8890\n- Frequent flyer | TP 99120');
  const { notes } = brief(surface, catalog);
  assert.ok(!notes.some((n) => n.includes('4417')), 'the briefing leaked a private value');
  assert.ok(notes.some((n) => /must not be spoken/.test(n)));
});

// ----------------------------------------------------------------- session

test('a spoken pick and a tapped pick produce the identical action', () => {
  const seen = [];
  const make = () => {
    const s = new Session({ catalog, onAction: (a) => seen.push(a) });
    s.renderSurface(FLIGHTS);
    return s;
  };
  make().selectOption('pick_flight', 2, 'voice');
  make().selectOption('pick_flight', 2, 'tap');

  assert.deepEqual(seen[0], seen[1]);
  assert.deepEqual(seen[0], { event: { name: 'pick_flight', context: { index: 1, title: 'easyJet' } } });
});

test('selection lands in the data model before anything leaves', () => {
  const s = new Session({ catalog });
  s.renderSurface(FLIGHTS);
  assert.equal(s.surface.dataModel.pick_flight.selected, null);
  s.selectOption('pick_flight', 3);
  assert.equal(s.surface.dataModel.pick_flight.selected, 2);
});

test('a bad render returns every error to the model instead of throwing', () => {
  const s = new Session({ catalog });
  const res = s.renderSurface('carousel x\ncards pick_flight\n- TAP | 06:15');
  assert.equal(res.ok, false);
  assert.equal(res.rendered, false);
  assert.equal(res.errors.length, 2);
  assert.match(res.errors[0], /^line 1: /);
  assert.equal(s.surface, null);
});

test('selecting out of range is refused with the real count', () => {
  const s = new Session({ catalog });
  s.renderSurface(FLIGHTS);
  const res = s.selectOption('pick_flight', 9);
  assert.equal(res.ok, false);
  assert.match(res.errors[0], /has 3 options; 9 is not one of them/);
});

test('selecting a component that is not on screen says what is', () => {
  const s = new Session({ catalog });
  s.renderSurface(FLIGHTS);
  const res = s.selectOption('pick_hotel', 1);
  assert.equal(res.ok, false);
  assert.match(res.hint, /pick_flight/);
});

test('call() dispatches Gemini function calls by name', () => {
  const s = new Session({ catalog });
  assert.equal(s.call('render_surface', { express: FLIGHTS }).ok, true);
  assert.equal(s.call('select_option', { action: 'pick_flight', index: 1 }).ok, true);
  assert.equal(s.call('nonsense', {}).ok, false);
});

// ------------------------------------------------------------------ prompt

test('the prompt is generated from the catalog, not hand-written', () => {
  const text = systemInstruction(catalog);
  for (const def of Object.values(catalog.components)) {
    if (!def.express) continue;
    assert.ok(text.includes(def.express.keyword), `prompt never mentions "${def.express.keyword}"`);
  }
  assert.ok(text.includes('- title | when | price | tag'));
  assert.ok(text.includes(catalog.examples[0].spoken));
});

test('the tool declarations advertise exactly the catalog keywords', () => {
  const [{ functionDeclarations: fns }] = functionDeclarations(catalog);
  assert.deepEqual(fns.map((f) => f.name), ['render_surface', 'select_option']);
  assert.match(fns[0].description, /cards/);
  assert.deepEqual(fns[0].parameters.required, ['express']);
});
