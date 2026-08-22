/**
 * The one test that can actually be wrong.
 *
 * Everything in express.test.mjs is a closed loop: my parser against my
 * transpiler. This one puts a real model in front of the grammar and asks
 * whether a machine that has never seen A2UI Express can write it correctly
 * from the generated prompt alone. If the answer is no, the prompt is wrong,
 * not the model.
 *
 *   GEMINI_API_KEY=… node --test test/live.test.mjs
 *
 * Skips without a key so CI stays green without secrets.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';

import { GeminiLive, LIVE_MODELS } from '../src/live/gemini-live.js';
import { Session } from '../src/session.js';
import { parseExpress } from '../src/express/parse.js';

const catalog = JSON.parse(readFileSync(new URL('../catalog/travel.catalog.json', import.meta.url), 'utf8'));

const apiKey = process.env.GEMINI_API_KEY
  ?? (existsSync(new URL('../.gemini-key', import.meta.url))
    ? readFileSync(new URL('../.gemini-key', import.meta.url), 'utf8').trim()
    : null);

const skip = apiKey ? false : 'set GEMINI_API_KEY to run the live tests';

/** Node has no proxy-aware WebSocket, and sandboxes tend to have a proxy. */
async function socket() {
  if (!process.env.HTTPS_PROXY) return { WebSocketImpl: globalThis.WebSocket };
  const [{ default: WS }, { HttpsProxyAgent }] = await Promise.all([
    import('ws'), import('https-proxy-agent'),
  ]);
  return { WebSocketImpl: WS, socketOptions: { agent: new HttpsProxyAgent(process.env.HTTPS_PROXY) } };
}

let transport;
before(async () => { if (apiKey) transport = await socket(); });

/** Drive one turn to completion and report everything that happened. */
async function turn(prompt, { model = LIVE_MODELS[0], timeoutMs = 60000 } = {}) {
  const seen = { tools: [], said: '', audioChunks: 0, audioBytes: 0, surfaces: [], actions: [] };
  const session = new Session({
    catalog,
    onSurface: (messages, surface) => seen.surfaces.push(surface),
    onAction: (action) => seen.actions.push(action),
  });
  const live = new GeminiLive({ apiKey, catalog, session, model, ...transport });

  live.on('tool', (t) => seen.tools.push(t));
  live.on('said', (t) => { seen.said += t; });
  live.on('audio', ({ base64 }) => { seen.audioChunks += 1; seen.audioBytes += Math.floor(base64.length * 0.75); });

  await live.connect();
  const startedAt = Date.now();

  const finished = new Promise((resolve, reject) => {
    live.on('turnComplete', resolve);
    live.on('close', ({ reason }) => reject(new Error(reason || 'closed early')));
    setTimeout(() => reject(new Error(`no turnComplete within ${timeoutMs}ms`)), timeoutMs).unref?.();
  });

  live.sendText(prompt);
  try {
    await finished;
  } finally {
    seen.ms = Date.now() - startedAt;
    seen.session = session;
    live.close();
  }
  return seen;
}

// ---------------------------------------------------------------------------

test('the model both speaks and renders in one turn', { skip, timeout: 90000 }, async () => {
  const seen = await turn('find me a direct flight to Lisbon next Friday, back Sunday night, under 300 euros');

  assert.ok(seen.audioChunks > 0, 'no audio came back — it never spoke');
  assert.ok(seen.said.trim().length > 0, 'no output transcript');

  const renders = seen.tools.filter((t) => t.name === 'render_surface');
  assert.ok(renders.length > 0, `it never called render_surface. It said: "${seen.said}"`);

  console.log(`\n  spoke   ${seen.audioChunks} chunks / ${(seen.audioBytes / 1024).toFixed(0)} KB in ${seen.ms}ms`);
  console.log(`  said    "${seen.said.trim()}"`);
  console.log(`  express\n${renders.at(-1).args.express.split('\n').map((l) => '          ' + l).join('\n')}`);
});

test('the Express it writes parses without repair', { skip, timeout: 90000 }, async () => {
  const seen = await turn('show me three hotels in central Lisbon under 200 a night');
  const renders = seen.tools.filter((t) => t.name === 'render_surface');
  assert.ok(renders.length, 'never rendered');

  const first = renders[0];
  const ir = parseExpress(first.args.express, catalog);
  assert.deepEqual(
    ir.errors, [],
    `first attempt did not parse:\n${first.args.express}\n\n${JSON.stringify(ir.errors, null, 2)}`,
  );
  assert.equal(first.response.ok, true);
});

test('a rendered surface produces a real A2UI payload and a briefing', { skip, timeout: 90000 }, async () => {
  const seen = await turn('what flights are there to Lisbon on Friday under 300 euros');
  const surface = seen.surfaces.at(-1);
  assert.ok(surface, 'no surface was built');

  const kinds = surface.messages.map((m) => Object.keys(m)[0]);
  assert.ok(kinds.includes('createSurface'));
  assert.ok(kinds.includes('updateComponents'));

  const root = surface.components[0];
  assert.equal(root.component, 'Column');
  assert.ok(root.children.length > 0);

  const render = seen.tools.filter((t) => t.name === 'render_surface').at(-1);
  assert.equal(render.response.ok, true);
  assert.ok(Array.isArray(render.response.guidance));

  console.log(`\n  A2UI    ${JSON.stringify(surface.messages).length} bytes, ${surface.components.length} components`);
  console.log(`  brief   ${JSON.stringify(render.response.showing)}`);
  render.response.guidance.forEach((g) => console.log(`          · ${g}`));
});

test('the transpiler rejects invalid Express and the model repairs it', { skip, timeout: 90000 }, async () => {
  // Ask for something the catalog cannot express, and check the failure path
  // is a correction rather than a crash or an apology to the user.
  const seen = await turn(
    'show me a bar chart of Lisbon flight prices over the next month, then just list three flights under 300 euros',
  );
  const renders = seen.tools.filter((t) => t.name === 'render_surface');
  assert.ok(renders.length, 'never rendered');

  const rejected = renders.filter((r) => !r.response.ok);
  const accepted = renders.filter((r) => r.response.ok);

  for (const r of rejected) {
    assert.ok(r.response.errors.length, 'a rejection with no errors listed');
    assert.match(r.response.errors[0], /^line \d+: /);
  }
  assert.ok(accepted.length, `every attempt was rejected:\n${JSON.stringify(rejected, null, 2)}`);
  console.log(`\n  attempts ${renders.length} (${rejected.length} rejected, ${accepted.length} accepted)`);
});

after(() => { if (skip) console.log(`\n  (live tests skipped — ${skip})`); });
