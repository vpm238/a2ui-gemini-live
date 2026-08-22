import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { parseExpress } from '../src/express/parse.js';
import { transpile, expansion } from '../src/express/transpile.js';
import { brief } from '../src/render/gates.js';
import { Session } from '../src/session.js';
import { systemInstruction, functionDeclarations, describeComponent } from '../src/express/prompt.js';

const load = (name) =>
  JSON.parse(readFileSync(new URL(`../catalog/${name}`, import.meta.url), 'utf8'));

const catalog = load('travel.catalog.json');
const clinic = load('clinic.catalog.json');
const index = load('index.json');

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
    title: 'easyJet', detail: '11:40–14:25', price: 'EUR 212', tag: 'direct',
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
  assert.match(errors[0].message, /expected 3–4 fields, found 2/);
  assert.match(errors[0].hint, /title \| detail \| price \| tag\?/);
  assert.equal(errors[0].line, 2);
});

test('a trailing optional field may be left off', () => {
  // A live run wrote hotels through `cards`, which has no departure time —
  // three fields where the grammar had demanded four. Fixed arity was wrong.
  const ir = parseExpress(
    'cards select_hotel\n- Browns Central | design focused | EUR 175', catalog);
  assert.deepEqual(ir.errors, []);
  assert.deepEqual(ir.nodes[0].items[0],
    { title: 'Browns Central', detail: 'design focused', price: 'EUR 175' });
  assert.equal('tag' in ir.nodes[0].items[0], false);
});

test('a required field may not be left off', () => {
  const { errors } = parseExpress('cards x_y\n- Browns Central | design focused', catalog);
  assert.match(errors[0].message, /expected 3–4 fields, found 2/);
});

test('optional fields must be declared last', () => {
  const bent = structuredClone(catalog);
  bent.components.OptionCards.express.fields = ['title', 'detail?', 'price', 'tag'];
  assert.throws(() => parseExpress('heading Hi', bent), /optional fields must come last/);
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
  assert.ok(text.includes('- title | detail | price | tag?'));
  assert.ok(text.includes(catalog.examples[0].spoken));
});

test('the tool declarations advertise exactly the catalog keywords', () => {
  const [{ functionDeclarations: fns }] = functionDeclarations(catalog);
  assert.deepEqual(fns.map((f) => f.name), ['render_surface', 'select_option']);
  assert.match(fns[0].description, /cards/);
  assert.deepEqual(fns[0].parameters.required, ['express']);
});


// ------------------------------------------------- the catalog IS the config

test('every catalog in the index loads and its own examples parse', () => {
  assert.ok(index.length >= 2, 'the picker needs something to pick between');
  for (const { file, title } of index) {
    const c = load(file);
    assert.ok(c.title, `${file} has no title`);
    assert.equal(typeof title, 'string');
    for (const example of c.examples ?? []) {
      const ir = parseExpress(example.express, c);
      assert.deepEqual(ir.errors, [], `${file} example failed:\n${example.express}`);
    }
    // Every component's own example must parse under its own catalog too.
    for (const [name, def] of Object.entries(c.components)) {
      if (!def.express?.example) continue;
      const ir = parseExpress(def.express.example, c);
      assert.deepEqual(ir.errors, [], `${file} ${name} example failed:\n${def.express.example}`);
    }
  }
});

test('a second catalog brings its own keywords, fields and gates', () => {
  // Nothing in src/ knows the word "slots" exists.
  const ir = parseExpress('slots book_slot\n- Tue 14 Jan, 09:20 | Dr Adeyemi | in person', clinic);
  assert.deepEqual(ir.errors, []);
  const { components } = transpile(ir, clinic);
  assert.equal(components.find((c) => c.id === 'book_slot').modality.stakes, 'confirm');

  // …and travel's keywords are meaningless under it.
  assert.match(parseExpress('cards pick_flight', clinic).errors[0].message, /not a component/);
});

test('swapping the catalog on a live Session swaps the whole grammar', () => {
  const s = new Session({ catalog });
  assert.equal(s.renderSurface(FLIGHTS).ok, true);

  s.setCatalog(clinic);
  assert.equal(s.surface, null, 'the old surface belonged to the old catalog');
  assert.equal(s.renderSurface(FLIGHTS).ok, false);
  assert.equal(s.renderSurface('slots book_slot\n- Tue, 09:20 | Dr Adeyemi | phone').ok, true);
});

// -------------------------------------------------------------- disclosure

test('flat discloses every component\'s syntax up front', () => {
  const text = systemInstruction(catalog, { disclosure: 'flat' });
  assert.ok(text.includes('- title | detail | price | tag?'));
  assert.ok(!text.includes('call describe'));
  const [{ functionDeclarations: fns }] = functionDeclarations(catalog, { disclosure: 'flat' });
  assert.deepEqual(fns.map((f) => f.name), ['render_surface', 'select_option']);
});

test('progressive discloses names only, and adds the tool to ask', () => {
  const text = systemInstruction(catalog, { disclosure: 'progressive' });
  for (const keyword of ['cards', 'seatmap', 'confirm', 'private']) {
    assert.ok(text.includes(keyword), `progressive prompt lost "${keyword}"`);
  }
  // The names are there; the field lists are not.
  assert.ok(!text.includes('- title | detail | price | tag?'));
  assert.ok(!text.includes('seat | kind | fee?'));
  assert.match(text, /call describe with its keyword/);

  const [{ functionDeclarations: fns }] = functionDeclarations(catalog, { disclosure: 'progressive' });
  assert.deepEqual(fns.map((f) => f.name), ['render_surface', 'select_option', 'describe']);
  assert.match(fns[2].parameters.properties.keyword.description, /cards/);
});

test('describe returns the syntax the flat prompt would have carried', () => {
  const out = describeComponent(catalog, 'cards');
  assert.equal(out.ok, true);
  assert.equal(out.fields, 'title | detail | price | tag?');
  assert.equal(out.itemsOnSeparateLines, true);
  assert.match(out.example, /^cards pick_flight/m);
  // And what it hands back must itself parse.
  assert.deepEqual(parseExpress(out.example, catalog).errors, []);
});

test('describe on an unknown keyword lists the real ones', () => {
  const out = describeComponent(catalog, 'carousel');
  assert.equal(out.ok, false);
  assert.ok(out.available.includes('cards'));
});

test('a Session dispatches describe like any other tool call', () => {
  const s = new Session({ catalog });
  assert.equal(s.call('describe', { keyword: 'confirm' }).ok, true);
  assert.equal(s.call('describe', { keyword: 'nope' }).ok, false);
});
