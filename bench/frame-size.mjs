/**
 * Where does progressive disclosure start paying for itself?
 *
 * The Live API sends the whole configuration in one frame, on every connect,
 * and it cannot be changed afterwards. So the cost of a capability is not
 * "when used" but "always" — which is the argument for holding component
 * syntax back until the model asks for it.
 *
 * That argument is only worth anything if the numbers support it, and at the
 * size of the catalogs in this repo they do not: the frame is mostly fixed
 * preamble — the grammar rules, the two-channels instruction, the worked
 * examples — and the per-component syntax is a rounding error next to it.
 *
 * This measures the crossover by generating catalogs of increasing size.
 *
 *   node bench/frame-size.mjs
 */

import { readFileSync } from 'node:fs';
import { systemInstruction, functionDeclarations } from '../src/express/prompt.js';

const frameBytes = (catalog, disclosure) => Buffer.byteLength(JSON.stringify({
  setup: {
    model: 'models/gemini-3.1-flash-live-preview',
    generationConfig: { responseModalities: ['AUDIO'] },
    systemInstruction: { parts: [{ text: systemInstruction(catalog, { disclosure }) }] },
    tools: functionDeclarations(catalog, { disclosure }),
    inputAudioTranscription: {},
    outputAudioTranscription: {},
  },
}));

/** A catalog of `n` plausible components — same shape, realistic prose length. */
function synthetic(n) {
  const components = {
    Column: { description: 'Vertical stack.', express: null },
  };
  for (let i = 0; i < n; i += 1) {
    components[`Widget${i}`] = {
      description:
        `Component number ${i} in this catalog. It shows a set of choices with a `
        + 'headline, a qualifier, a price and an optional tag, and the user picks '
        + 'one by tapping it or by saying which one they mean.',
      express: {
        keyword: `kw${i}`,
        head: ['action'],
        list: true,
        fields: ['title', 'detail', 'price', 'tag?'],
        example: `kw${i} pick_thing\n- A headline | a qualifier | EUR 100 | a tag`,
      },
      speech: { item: '{title}, {detail}, {price}' },
      modality: { requiresVisual: false, stakes: 'none', spokenSensitive: false },
    };
  }
  return {
    catalogId: 'https://example.test/synthetic',
    title: `Synthetic (${n})`,
    persona: 'an assistant',
    instructions: 'Render one decision, never a page.',
    components,
    examples: [],
  };
}

const rows = [];
for (const n of [1, 3, 5, 7, 10, 15, 20, 30, 40, 60, 80, 120]) {
  const c = synthetic(n);
  const flat = frameBytes(c, 'flat');
  const prog = frameBytes(c, 'progressive');
  rows.push({ n, flat, prog, saved: flat - prog, pct: ((flat - prog) / flat) * 100 });
}

console.log('\n  components   flat      progressive   saved      %');
console.log('  ' + '-'.repeat(52));
for (const r of rows) {
  console.log(
    `  ${String(r.n).padStart(8)}   ${String(r.flat).padStart(6)} B  ${String(r.prog).padStart(9)} B  `
    + `${String(r.saved).padStart(7)} B  ${r.pct.toFixed(1).padStart(5)}%`,
  );
}

const crossover = rows.find((r) => r.saved > 0);
const worthwhile = rows.find((r) => r.pct >= 25);
console.log(
  `\n  first byte saved at ~${crossover?.n ?? '>120'} components; `
  + `25% saved at ~${worthwhile?.n ?? '>120'} components.`,
);

// And the two catalogs that actually exist, for scale.
console.log('\n  real catalogs:');
for (const file of ['travel', 'clinic']) {
  const c = JSON.parse(readFileSync(new URL(`../catalog/${file}.catalog.json`, import.meta.url), 'utf8'));
  const n = Object.values(c.components).filter((x) => x.express).length;
  const flat = frameBytes(c, 'flat');
  const prog = frameBytes(c, 'progressive');
  const delta = flat - prog;
  console.log(
    `    ${file.padEnd(8)} ${String(n).padStart(2)} components   flat ${flat} B   `
    + `progressive ${prog} B   ${delta >= 0 ? 'saves' : 'COSTS'} ${Math.abs(delta)} B`,
  );
}
console.log();
