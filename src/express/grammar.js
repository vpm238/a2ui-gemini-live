/**
 * The grammar is not written down anywhere. It is derived from the catalog.
 *
 * That is the whole trick. `catalog/travel.catalog.json` gives every component
 * an `express` block — a keyword, its head arguments, its item fields — and
 * three things fall out of it automatically:
 *
 *   1. the parser's keyword table            (parse.js)
 *   2. the grammar shown to the model        (prompt.js)
 *   3. the shape the transpiler emits        (transpile.js)
 *
 * Add a component to the catalog and it gains a syntax, a prompt entry and a
 * transpilation in one edit. Remove it and every line that names it stops
 * parsing. There is no second place to keep in sync, and no way for the model
 * to be told about a component the parser doesn't accept.
 */

/** Keyword reserved for the surface declaration; not a component. */
export const SURFACE_KEYWORD = 'surface';

/** Action names become data-model paths and event names, so keep them tame. */
export const ACTION_RE = /^[a-z][a-z0-9_]*$/;

/**
 * Build the keyword table.
 *
 * @param {object} catalog
 * @returns {Map<string, {keyword: string, component: string, head: string[],
 *   fields: string[], list: boolean, description: string, speech: object,
 *   modality: object}>}
 */
export function grammarOf(catalog) {
  const table = new Map();

  for (const [component, def] of Object.entries(catalog.components ?? {})) {
    const express = def.express;
    if (!express) continue; // Column and friends: structural, never written.

    if (table.has(express.keyword)) {
      throw new Error(
        `catalog defines the keyword "${express.keyword}" twice ` +
        `(${table.get(express.keyword).component} and ${component})`,
      );
    }
    if (express.keyword === SURFACE_KEYWORD) {
      throw new Error(`"${SURFACE_KEYWORD}" is reserved and cannot name a component`);
    }

    // A trailing `?` marks a field optional, and they must come last. Values
    // fill left to right, so an optional field in the middle would make
    // position ambiguous: three values against `title | when? | price` could
    // mean either reading, and the parser would have to guess which.
    const declared = (express.fields ?? []).map((f) => ({
      name: f.replace(/\?$/, ''),
      optional: f.endsWith('?'),
    }));
    const firstOptional = declared.findIndex((f) => f.optional);
    if (firstOptional !== -1 && declared.slice(firstOptional).some((f) => !f.optional)) {
      throw new Error(`${component}: optional fields must come last (${express.fields.join(' | ')})`);
    }

    table.set(express.keyword, {
      keyword: express.keyword,
      component,
      head: express.head ?? [],
      fields: declared.map((f) => f.name),
      /** How many of `fields` must be present. The rest may be omitted. */
      required: firstOptional === -1 ? declared.length : firstOptional,
      list: express.list === true,
      description: def.description ?? '',
      speech: def.speech ?? {},
      modality: def.modality ?? {},
    });
  }

  if (!table.size) throw new Error('catalog declares no Express components');
  return table;
}

/** Every keyword a source file may use, for error messages and the prompt. */
export function keywords(catalog) {
  return [...grammarOf(catalog).keys()];
}

/** `title | detail | price | tag?` — the `?` survives into the prompt. */
export function fieldList(spec) {
  return spec.fields.map((f, i) => (i < spec.required ? f : `${f}?`)).join(' | ');
}

/**
 * One line of syntax per component, e.g.
 *   cards <action>              then one or more:  - title | detail | price | tag?
 *   confirm <action> | summary | amount | method
 */
export function signature(spec) {
  const head = spec.head.map((h) => (h === 'text' ? '<text…>' : `<${h}>`)).join(' ');
  const inline = spec.list ? '' : spec.fields.map((f, i) => ` | ${i < spec.required ? f : `${f}?`}`).join('');
  const line = [spec.keyword, head].filter(Boolean).join(' ') + inline;
  if (!spec.list) return line;
  return `${line}\n    - ${fieldList(spec)}     (one line per item)`;
}
