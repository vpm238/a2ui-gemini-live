/**
 * Catalog → system instruction, and catalog → function declarations.
 *
 * The first probe against Gemini Live is the reason this file exists. Given a
 * tool called `render_surface` that takes a string named `express` and no
 * further guidance, the model cheerfully invented an entire markup language —
 * YAML front-matter, an XML template body, `<foreach>`, `${}` interpolation,
 * inline CSS. All of it plausible, none of it parseable.
 *
 * A model handed a slot will fill the slot. So the slot has to come with its
 * grammar attached, and the grammar has to come from the same catalog the
 * parser reads, or the two drift apart on the first edit.
 *
 * TWO WAYS TO ATTACH IT
 *
 * `flat` puts every component's full syntax in the setup frame. Simple, and
 * the model has everything before it says a word.
 *
 * `progressive` puts only a keyword and a one-line summary up front, and adds
 * a `describe` tool the model calls to get the exact syntax for a component
 * when it decides to use one. That is what Claude Code's skills do, rebuilt in
 * userspace — because the Live API has no equivalent. Its setup frame is sent
 * once per connection and is immutable: a second `setup` closes the socket
 * with 1007. Everything the model may ever do is in that one frame or it does
 * not exist, so the only way to have a large catalog without paying for all of
 * it every session is to make the model ask.
 *
 * Whether that trade is worth taking is a measurement, not an opinion. See
 * bench/disclosure.mjs and docs/DISCLOSURE.md for the numbers.
 */

import { grammarOf, signature, fieldList } from './grammar.js';

export const DISCLOSURE = ['flat', 'progressive'];

/** The rules that aren't derivable from any one component. */
const SYNTAX = `A2UI Express is line-oriented. One component per line.

  * The first word of a line is the component keyword.
  * A line starting with "-" adds one item to the list component above it.
  * "|" separates fields. Whitespace around it is ignored.
  * A blank line, or a line starting with "#", is ignored.
  * Nothing nests and nothing is quoted. There are no brackets to balance.
  * A field written "name?" is optional and may be left off the END of a line.
    Fields fill left to right, so one cannot be skipped in the middle.
  * Optionally begin with "surface <name>" to name the surface.

Write plain text in fields — no markup, no quotes, no currency symbols that
are hard to pronounce (write "EUR 189", not "€189").`;

/**
 * @param {object} catalog
 * @param {{disclosure?: 'flat'|'progressive'}} [options]
 * @returns {string}
 */
export function systemInstruction(catalog, { disclosure = 'flat' } = {}) {
  const table = grammarOf(catalog);
  const progressive = disclosure === 'progressive';

  const components = progressive
    ? [...table.values()]
      .map((spec) => `${spec.keyword.padEnd(9)} ${summarise(spec.description)}`)
      .join('\n  ')
    : [...table.values()]
      .map((spec) => `${signature(spec)}\n      ${spec.description}`)
      .join('\n\n  ');

  const componentRules = progressive
    ? `You have been given each component's NAME, not its syntax. Before you
use a component for the first time, call describe with its keyword to get
its exact fields. Do not guess them — a guess costs a round trip and you
will be told the same thing describe would have told you.`
    : '';

  const examples = (catalog.examples ?? [])
    .map(({ spoken, express }, n) => `  ${n + 1}. You say aloud: "${spoken}"\n     You call render_surface with:\n${indent(express, 8)}`)
    .join('\n\n');

  return `You are ${catalog.persona ?? 'an assistant'} speaking with someone who also has a screen in front of them.

TWO CHANNELS, ONE TURN.
Your voice and the screen do different jobs, and you use both in the same turn.
Speak the judgement — the one sentence that moves the decision along. Put the
detail on the screen by calling the render_surface tool. Never read a list
aloud; that is what the screen is for. Never describe what is on the screen
either — the user can see it.

${catalog.instructions ?? ''}

CALL render_surface WHILE YOU TALK, NOT AFTER.
render_surface is synchronous: it returns you a short note about what is now
on screen, including how the options are numbered. Call it as soon as you know
what you are showing, then keep talking. Do not announce that you are about to
show something.

THE GRAMMAR
${indent(SYNTAX, 2)}

THE COMPONENTS — these are the only ones that exist
  ${components}
${componentRules ? `\n${componentRules}\n` : ''}${examples ? `EXAMPLES\n${examples}\n` : ''}
WHEN THE USER PICKS ONE
If they say "the second one", "the easyJet one", "the cheapest" — call
select_option with the component's action name and the 1-based index. Do not
re-render the list to indicate a selection; select_option does that.

If render_surface returns errors, fix the lines it names and call it again.
Do not apologise aloud for a failed render — the user never saw it.`;
}

/**
 * The tools. All are blocking — no `behavior: NON_BLOCKING` anywhere — and
 * that is deliberate: a blocking call is the only point at which the renderer
 * can inspect a surface and tell the model what it may say about it *before*
 * the model says it. Made asynchronous, the modality gates would arrive after
 * the sentence they were meant to govern.
 */
export function functionDeclarations(catalog, { disclosure = 'flat' } = {}) {
  const kw = [...grammarOf(catalog).keys()];
  const declarations = [
    {
      name: 'render_surface',
      description:
        'Put a surface on the screen, written in A2UI Express. Returns what is now ' +
        'displayed and how its options are numbered, or the parse errors to fix. ' +
        `Keywords available: ${kw.join(', ')}.`,
      parameters: {
        type: 'OBJECT',
        properties: {
          express: {
            type: 'STRING',
            description:
              'A2UI Express source. Line-oriented: one component per line, "-" for ' +
              'list items, "|" between fields. No markup, no quoting, no nesting.',
          },
        },
        required: ['express'],
      },
    },
    {
      name: 'select_option',
      description:
        'Record that the user chose one of the options currently on screen. ' +
        'Use when they refer to one by position, name or attribute.',
      parameters: {
        type: 'OBJECT',
        properties: {
          action: { type: 'STRING', description: 'The action name of the component, e.g. pick_flight.' },
          index: { type: 'INTEGER', description: '1-based position in the list as rendered.' },
        },
        required: ['action', 'index'],
      },
    },
  ];

  if (disclosure === 'progressive') {
    declarations.push({
      name: 'describe',
      description:
        'Get the exact A2UI Express syntax for one component: its fields, which ' +
        'are optional, and an example line. Call this before using a component ' +
        `you have not yet used in this session. Keywords: ${kw.join(', ')}.`,
      parameters: {
        type: 'OBJECT',
        properties: {
          keyword: { type: 'STRING', description: `One of: ${kw.join(', ')}.` },
        },
        required: ['keyword'],
      },
    });
  }

  return [{ functionDeclarations: declarations }];
}

/**
 * What `describe` returns. Also what the setup inspector shows for a
 * component, so the two can never disagree about what the model was told.
 */
export function describeComponent(catalog, keyword) {
  const spec = grammarOf(catalog).get(String(keyword ?? '').trim());
  if (!spec) {
    const kw = [...grammarOf(catalog).keys()];
    return { ok: false, errors: [`"${keyword}" is not a component in this catalog`], available: kw };
  }

  const out = {
    ok: true,
    keyword: spec.keyword,
    syntax: signature(spec),
    description: spec.description,
  };
  if (spec.fields.length) {
    out.fields = fieldList(spec);
    out.itemsOnSeparateLines = spec.list;
  }
  if (spec.head.includes('action')) {
    out.note = 'The action name is yours to choose; it identifies this component and must be unique on the surface.';
  }
  if (spec.example) out.example = spec.example;
  return out;
}

/** First sentence of the description, for the progressive component list. */
function summarise(description) {
  const first = String(description ?? '').split(/(?<=[.;])\s/)[0].trim();
  return first.length > 96 ? `${first.slice(0, 93)}…` : first;
}

function indent(text, n) {
  const pad = ' '.repeat(n);
  return String(text).split('\n').map((l) => (l ? pad + l : l)).join('\n');
}
