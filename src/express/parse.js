/**
 * A2UI Express → intermediate representation.
 *
 * Express is line-oriented on purpose. A model producing this over a live
 * audio session is streaming tokens under latency pressure, and the two
 * things it reliably gets wrong in that state are *balanced delimiters* and
 * *indentation*. So there are none: the first word of a line is the keyword,
 * `-` continues the list above it, `|` separates fields, and a newline ends
 * everything. Nothing nests, so nothing can be left unclosed.
 *
 * The parser never throws and never stops at the first problem. It returns
 * every error it found, each with a line number and a hint, because the
 * whole list goes straight back to the model in the tool response — one
 * round trip to repair, not one per mistake.
 */

import { grammarOf, keywords, fieldList, SURFACE_KEYWORD, ACTION_RE } from './grammar.js';

/**
 * @typedef {object} Node
 * @property {string} keyword
 * @property {string} component     catalog component name
 * @property {Record<string,string>} head
 * @property {Array<Record<string,string>>} items
 * @property {number} line
 * @property {object} spec          the grammar entry, carried for the transpiler
 */

/**
 * @param {string} source
 * @param {object} catalog
 * @returns {{surfaceId: string, nodes: Node[], errors: Array<{line:number,text:string,message:string,hint?:string}>}}
 */
export function parseExpress(source, catalog) {
  const table = grammarOf(catalog);
  const errors = [];
  const nodes = [];
  let surfaceId = 'main';
  let surfaceSeen = false;

  const fail = (line, text, message, hint) => errors.push({ line, text, message, ...(hint && { hint }) });

  const lines = String(source ?? '').split(/\r?\n/);
  let last = null; // the most recent list node, for `-` continuation

  lines.forEach((raw, i) => {
    const lineNo = i + 1;
    const text = raw.trim();
    if (!text || text.startsWith('#')) return;

    // ---------------------------------------------------------- item line
    if (text.startsWith('-')) {
      const body = text.slice(1).trim();
      if (!last) {
        fail(lineNo, text, 'this item has no list above it',
          'an item line must follow a list component such as `cards <action>`');
        return;
      }
      const values = splitFields(body);
      if (!fits(values.length, last.spec)) {
        last.brokenItems += 1;
        fail(lineNo, text,
          `expected ${arity(last.spec)} fields, found ${values.length}`,
          `\`${last.keyword}\` items are: ${fieldList(last.spec)}`);
        return;
      }
      if (values.some((v) => !v)) {
        last.brokenItems += 1;
        fail(lineNo, text, 'a field is empty', 'every field between the pipes needs a value');
        return;
      }
      last.items.push(collect(last.spec, values));
      return;
    }

    // ------------------------------------------------------ keyword line
    const [keyword, ...restWords] = text.split(/\s+/);
    const rest = text.slice(keyword.length).trim();

    if (keyword === SURFACE_KEYWORD) {
      if (surfaceSeen) fail(lineNo, text, 'a second `surface` line', 'declare the surface once, at the top');
      if (nodes.length) fail(lineNo, text, '`surface` must come first', 'move it above the components');
      if (!restWords.length) fail(lineNo, text, '`surface` needs a name', 'e.g. `surface flights`');
      else if (!ACTION_RE.test(restWords[0])) {
        fail(lineNo, text, `"${restWords[0]}" is not a valid surface name`, 'lowercase letters, digits and underscores');
      } else surfaceId = restWords[0];
      surfaceSeen = true;
      last = null;
      return;
    }

    const spec = table.get(keyword);
    if (!spec) {
      fail(lineNo, text, `"${keyword}" is not a component in this catalog`,
        `available: ${keywords(catalog).join(', ')}`);
      last = null;
      return;
    }

    const node = { keyword, component: spec.component, head: {}, items: [], brokenItems: 0, line: lineNo, spec };

    // `head: ['text']` means the rest of the line is prose — no pipes, no splitting.
    if (spec.head.length === 1 && spec.head[0] === 'text') {
      if (!rest) fail(lineNo, text, `\`${keyword}\` needs some text after it`);
      else node.head.text = rest;
      nodes.push(node);
      last = null;
      return;
    }

    const segments = splitFields(rest);
    const headWords = segments[0] ? segments[0].split(/\s+/) : [];

    if (headWords.length < spec.head.length) {
      fail(lineNo, text, `\`${keyword}\` needs ${spec.head.join(', ')}`,
        `e.g. \`${keyword} ${spec.head.map((h) => `<${h}>`).join(' ')}\``);
      last = null;
      return;
    }
    if (headWords.length > spec.head.length) {
      fail(lineNo, text, `unexpected \`${headWords.slice(spec.head.length).join(' ')}\` after \`${keyword}\``,
        spec.head.length
          ? `\`${keyword}\` takes exactly ${spec.head.length} argument(s): ${spec.head.join(', ')}`
          : `\`${keyword}\` takes no arguments`);
      last = null;
      return;
    }
    spec.head.forEach((name, n) => { node.head[name] = headWords[n]; });

    if (node.head.action && !ACTION_RE.test(node.head.action)) {
      fail(lineNo, text, `"${node.head.action}" is not a valid action name`,
        'lowercase letters, digits and underscores, e.g. `pick_flight`');
    }

    const inline = segments.slice(1);
    if (spec.list) {
      if (inline.length) {
        fail(lineNo, text, `\`${keyword}\` takes its values on following \`-\` lines`,
          `- ${fieldList(spec)}`);
      }
    } else if (spec.fields.length) {
      if (!fits(inline.length, spec)) {
        fail(lineNo, text, `expected ${arity(spec)} fields after \`${keyword} ${spec.head.join(' ')}\`, found ${inline.length}`,
          `\`${keyword} <${spec.head.join('> <')}> | ${fieldList(spec)}\``);
      } else if (inline.some((v) => !v)) {
        fail(lineNo, text, 'a field is empty', 'every field between the pipes needs a value');
      } else {
        node.items.push(collect(spec, inline));
      }
    }

    nodes.push(node);
    last = spec.list ? node : null;
  });

  // ------------------------------------------------------------- whole-file
  for (const node of nodes) {
    // Only complain about emptiness if nothing was *attempted*. A list whose
    // item lines all failed has already been told what is wrong with them,
    // and "…and now it is empty" is a consequence, not a second mistake.
    if (node.spec.list && !node.items.length && !node.brokenItems) {
      fail(node.line, `${node.keyword} …`, `\`${node.keyword}\` has no items`,
        `add at least one \`- ${fieldList(node.spec)}\` line beneath it`);
    }
  }
  if (!nodes.length && !errors.length) {
    fail(1, '', 'nothing to render', `write at least one component line, e.g. \`${keywords(catalog)[0]} …\``);
  }
  const seen = new Set();
  for (const node of nodes) {
    const id = node.head.action;
    if (!id) continue;
    if (seen.has(id)) {
      fail(node.line, `${node.keyword} ${id}`, `the action "${id}" is used twice`,
        'each action name identifies one component, so give the second one a different name');
    }
    seen.add(id);
  }

  return { surfaceId, nodes, errors };
}

/** Trailing optional fields may be left off, so arity is a range. */
const fits = (n, spec) => n >= spec.required && n <= spec.fields.length;

const arity = (spec) =>
  (spec.required === spec.fields.length ? `${spec.required}` : `${spec.required}–${spec.fields.length}`);

/** Fill left to right; whatever ran out stays absent rather than empty. */
const collect = (spec, values) =>
  Object.fromEntries(values.map((v, n) => [spec.fields[n], v]));

/** Split on `|`, trim, and drop a trailing empty segment from `a | b |`. */
function splitFields(text) {
  if (!text) return [];
  const parts = text.split('|').map((s) => s.trim());
  if (parts.length > 1 && parts.at(-1) === '') parts.pop();
  return parts;
}
