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
 */

import { grammarOf, signature } from './grammar.js';

/** The rules that aren't derivable from any one component. */
const SYNTAX = `A2UI Express is line-oriented. One component per line.

  * The first word of a line is the component keyword.
  * A line starting with "-" adds one item to the list component above it.
  * "|" separates fields. Whitespace around it is ignored.
  * A blank line, or a line starting with "#", is ignored.
  * Nothing nests and nothing is quoted. There are no brackets to balance.
  * Optionally begin with "surface <name>" to name the surface.

Write plain text in fields — no markup, no quotes, no currency symbols that
are hard to pronounce (write "EUR 189", not "€189").`;

/**
 * @param {object} catalog
 * @returns {string}
 */
export function systemInstruction(catalog) {
  const table = grammarOf(catalog);

  const components = [...table.values()]
    .map((spec) => `${signature(spec)}\n      ${spec.description}`)
    .join('\n\n  ');

  const examples = (catalog.examples ?? [])
    .map(({ spoken, express }, n) => `  ${n + 1}. You say aloud: "${spoken}"\n     You call render_surface with:\n${indent(express, 8)}`)
    .join('\n\n');

  return `You are a travel concierge speaking with someone who also has a screen in front of them.

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

EXAMPLES
${examples}

WHEN THE USER PICKS ONE
If they say "the second one", "the easyJet one", "the cheapest" — call
select_option with the component's action name and the 1-based index. Do not
re-render the list to indicate a selection; select_option does that.

If render_surface returns errors, fix the lines it names and call it again.
Do not apologise aloud for a failed render — the user never saw it.`;
}

/**
 * The two tools. Both are blocking (no `behavior: NON_BLOCKING`) and that is
 * deliberate: a blocking call is the only point at which the renderer can
 * inspect a surface and tell the model what it may say about it *before* the
 * model says it. Made asynchronous, the modality gates would arrive after the
 * sentence they were meant to govern.
 */
export function functionDeclarations(catalog) {
  const kw = [...grammarOf(catalog).keys()];
  return [{
    functionDeclarations: [
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
    ],
  }];
}

function indent(text, n) {
  const pad = ' '.repeat(n);
  return String(text).split('\n').map((l) => (l ? pad + l : l)).join('\n');
}
