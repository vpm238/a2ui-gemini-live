/**
 * Does progressive disclosure actually work, and what does it cost?
 *
 * frame-size.mjs answers the cheap half — how many bytes it saves. This
 * answers the half that decides it: whether a model that has been told only a
 * component's NAME can still write correct A2UI Express by asking, and how
 * many extra round trips it spends doing so.
 *
 * Both are real sessions against the real model. Nothing here is simulated.
 *
 *   GEMINI_API_KEY=… node bench/disclosure.mjs [travel|clinic]
 */

import { readFileSync, existsSync } from 'node:fs';
import { GeminiLive, byteLength } from '../src/live/gemini-live.js';
import { Session } from '../src/session.js';
import { parseExpress } from '../src/express/parse.js';

const which = process.argv[2] ?? 'travel';
const catalog = JSON.parse(readFileSync(new URL(`../catalog/${which}.catalog.json`, import.meta.url), 'utf8'));

const apiKey = process.env.GEMINI_API_KEY
  ?? (existsSync(new URL('../.gemini-key', import.meta.url))
    ? readFileSync(new URL('../.gemini-key', import.meta.url), 'utf8').trim()
    : null);
if (!apiKey) {
  console.error('set GEMINI_API_KEY');
  process.exit(1);
}

const PROMPTS = {
  travel: [
    'find me a direct flight to Lisbon next Friday under 300 euros',
    'show me three hotels in central Lisbon under 200 a night',
    'can I see the seats on that flight',
    'ok book the cheapest one',
    'what personal details do you have on file for me',
  ],
  clinic: [
    'I need an appointment with Dr Adeyemi this week',
    'what am I currently prescribed',
    'book me in for the blood test',
    'show me where the pain is so I can point at it',
    'anything on Friday afternoon',
  ],
}[which];

async function transport() {
  if (!process.env.HTTPS_PROXY) return { WebSocketImpl: globalThis.WebSocket };
  const [{ default: WS }, { HttpsProxyAgent }] = await Promise.all([
    import('ws'), import('https-proxy-agent'),
  ]);
  return { WebSocketImpl: WS, socketOptions: { agent: new HttpsProxyAgent(process.env.HTTPS_PROXY) } };
}
const wire = await transport();

/** One prompt, one fresh session, everything recorded. */
async function run(prompt, disclosure, timeoutMs = 60000) {
  const seen = {
    describes: 0, renders: 0, rejected: 0,
    firstRenderOk: null, firstRenderMs: null, audioChunks: 0, ms: 0, express: null,
  };
  const session = new Session({ catalog });
  const live = new GeminiLive({ apiKey, catalog, session, disclosure, ...wire });

  live.on('setupSent', ({ bytes }) => { seen.setupBytes = bytes; });
  live.on('audio', () => { seen.audioChunks += 1; });
  live.on('tool', ({ name, args, response }) => {
    if (name === 'describe') { seen.describes += 1; return; }
    if (name !== 'render_surface') return;
    seen.renders += 1;
    if (!response.ok) seen.rejected += 1;
    if (seen.firstRenderOk === null) {
      seen.firstRenderOk = response.ok;
      seen.firstRenderMs = Date.now() - startedAt;
    }
    if (response.ok) seen.express ??= args.express;
  });

  await live.connect();
  const startedAt = Date.now();

  const finished = new Promise((resolve, reject) => {
    live.on('turnComplete', resolve);
    live.on('close', ({ reason }) => reject(new Error(reason || 'closed early')));
    setTimeout(() => reject(new Error('timeout')), timeoutMs).unref?.();
  });

  live.sendText(prompt);
  try {
    await finished;
  } catch (err) {
    seen.error = err.message;
  } finally {
    seen.ms = Date.now() - startedAt;
    live.close();
  }

  // Independent of what the session said: does the Express it settled on parse?
  seen.parses = seen.express ? parseExpress(seen.express, catalog).errors.length === 0 : null;
  return seen;
}

// ---------------------------------------------------------------------------

const results = {};
for (const disclosure of ['flat', 'progressive']) {
  results[disclosure] = [];
  for (const prompt of PROMPTS) {
    const r = await run(prompt, disclosure);
    results[disclosure].push({ prompt, ...r });
    process.stdout.write(
      `  ${disclosure.padEnd(12)} ${r.error ? 'ERR ' : r.renders ? 'ok  ' : '--  '}`
      + `renders=${r.renders} describes=${r.describes} rejected=${r.rejected} `
      + `first=${r.firstRenderMs ?? '-'}ms turn=${r.ms}ms  ${prompt.slice(0, 42)}\n`,
    );
  }
}

const summarise = (rows) => {
  const rendered = rows.filter((r) => r.renders > 0);
  const firstOk = rendered.filter((r) => r.firstRenderOk).length;
  const avg = (f) => {
    const xs = rendered.map(f).filter((x) => typeof x === 'number');
    return xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : null;
  };
  return {
    setupBytes: rows[0]?.setupBytes ?? null,
    rendered: `${rendered.length}/${rows.length}`,
    firstAttemptOk: `${firstOk}/${rendered.length}`,
    describes: rows.reduce((a, r) => a + r.describes, 0),
    rejected: rows.reduce((a, r) => a + r.rejected, 0),
    avgFirstRenderMs: avg((r) => r.firstRenderMs),
    avgTurnMs: avg((r) => r.ms),
    parsedClean: `${rendered.filter((r) => r.parses).length}/${rendered.length}`,
  };
};

console.log(`\n=== ${catalog.title} · ${PROMPTS.length} prompts each ===\n`);
console.table({ flat: summarise(results.flat), progressive: summarise(results.progressive) });
