/**
 * Drive the scripted demo in a real browser.
 *
 * The bugs this catches are the ones unit tests structurally cannot: a module
 * that does not resolve, a stylesheet rule that swallows clicks, a renderer
 * that draws a card nobody can press. The previous iteration of this project
 * shipped an invisible overlay that ate every tap and passed every unit test,
 * so the tap assertions below are not ceremony.
 *
 *   npx playwright install chromium   # already present in this image
 *   node --test test/browser.test.mjs
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { chromium } from 'playwright';

/** This image ships a Chromium here; a CI runner has Playwright's own. */
const SANDBOX_CHROMIUM = '/opt/pw-browsers/chromium';

const ROOT = new URL('..', import.meta.url).pathname;
const TYPES = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.json': 'application/json',
};

let server; let browser; let origin;

before(async () => {
  server = createServer(async (req, res) => {
    // Contain the path: this serves the repo, and only the repo.
    const rel = normalize(decodeURIComponent(req.url.split('?')[0])).replace(/^(\.\.[/\\])+/, '');
    const file = join(ROOT, rel);
    try {
      const body = await readFile(file);
      res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' });
      res.end(body);
    } catch {
      res.writeHead(404).end('not found');
    }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch(
    existsSync(SANDBOX_CHROMIUM) ? { executablePath: SANDBOX_CHROMIUM } : {},
  );
});

after(async () => {
  await browser?.close();
  await new Promise((r) => server?.close(r));
});

/** A page plus everything it complained about. */
async function open(path = '/demo/offline.html') {
  const page = await browser.newPage();
  const problems = [];
  page.on('console', (m) => { if (m.type() === 'error') problems.push(m.text()); });
  page.on('pageerror', (e) => problems.push(String(e)));
  await page.goto(`${origin}${path}`, { waitUntil: 'networkidle' });
  return { page, problems };
}

const next = async (page, times = 1) => {
  for (let i = 0; i < times; i += 1) await page.click('#step');
};

// ---------------------------------------------------------------------------

test('the page loads its whole module graph without errors', async () => {
  const { page, problems } = await open();
  assert.deepEqual(problems, [], `console errors:\n${problems.join('\n')}`);
  assert.equal(await page.textContent('#state'), 'ready');
  assert.match(await page.textContent('#screen'), /Nothing on screen yet/);
  await page.close();
});

test('a rendered surface reaches the screen with its cards numbered', async () => {
  const { page, problems } = await open();
  await next(page, 3);

  assert.equal(await page.locator('.c-heading .text').textContent(), 'Lisbon · Fri 14 – Sun 16');
  assert.equal(await page.locator('.item').count(), 3);
  assert.deepEqual(await page.locator('.item .n').allTextContents(), ['1', '2', '3']);
  assert.match(await page.locator('.item').nth(1).textContent(), /easyJet/);
  assert.match(await page.locator('.c-status .text').textContent(), /Prices held/);
  assert.deepEqual(problems, []);
  await page.close();
});

test('the wire pane shows the Express, the A2UI, and the expansion', async () => {
  const { page } = await open();
  await next(page, 3);

  assert.match(await page.locator('.hop-express pre').first().textContent(), /cards pick_flight/);
  const a2ui = JSON.parse(await page.locator('.hop-a2ui pre').first().textContent());
  assert.deepEqual(a2ui.map((m) => Object.keys(m)[0]),
    ['createSurface', 'updateDataModel', 'updateComponents']);

  const ratio = await page.locator('.hop-express .ratio').first().textContent();
  assert.match(ratio, /wrote\s*\d+ B/);
  assert.match(ratio, /×\d/);
  await page.close();
});

test('a card can actually be clicked, and selecting is visible immediately', async () => {
  const { page, problems } = await open();
  await next(page, 3);

  await page.locator('.item').nth(1).click();
  await page.waitForSelector('.item.is-selected');

  assert.equal(await page.locator('.item.is-selected .lead').textContent(), 'easyJet');
  assert.equal(await page.locator('.item').nth(1).getAttribute('aria-pressed'), 'true');
  assert.equal(await page.locator('.item').nth(0).getAttribute('aria-pressed'), 'false');
  assert.deepEqual(problems, []);
  await page.close();
});

test('a tapped pick and a spoken pick emit byte-identical actions', async () => {
  const { page } = await open();

  await next(page, 3);
  await page.locator('.item').nth(1).click();
  const tapped = await page.locator('.hop-action pre').first().textContent();

  await page.click('#reset');
  await next(page, 5); // …through the scripted "the second one"
  const spoken = await page.locator('.hop-action pre').first().textContent();

  assert.equal(tapped, spoken);
  assert.deepEqual(JSON.parse(tapped), {
    event: { name: 'pick_flight', context: { index: 1, title: 'easyJet' } },
  });
  await page.close();
});

test('a component outside the catalog is rejected with a line number', async () => {
  const { page } = await open();
  await next(page, 9); // …up to and including the chart the catalog has no word for

  const reject = page.locator('.hop-reject').first();
  await reject.waitFor();
  assert.match(await reject.locator('li').first().textContent(), /line 2: "chart" is not a component/);
  assert.match(await reject.locator('li').first().textContent(), /available: heading, cards/);

  // …and the next beat is a surface that does parse.
  await next(page, 1);
  assert.match(await page.locator('.c-status .text').textContent(), /EUR 180 and EUR 260/);
  await page.close();
});

test('the gates are visible on screen: screen-only, readback, never-spoken', async () => {
  const { page } = await open();

  await next(page, 7);
  assert.equal(await page.locator('.marker.m-screen').textContent(), 'screen only');

  await next(page, 5);
  assert.equal(await page.locator('.marker.m-readback').textContent(), 'readback');
  assert.match(await page.locator('.panel').textContent(), /EUR 212\.00/);

  await next(page, 2);
  assert.equal(await page.locator('.marker.m-never').textContent(), 'never spoken');
  // Rendered in full on screen…
  assert.match(await page.locator('.c-sensitivelist').textContent(), /PT 4417 8890/);
  // …and never handed to the model to read aloud.
  const brief = await page.locator('.hop-brief').first().textContent();
  assert.doesNotMatch(brief, /4417 8890/);
  assert.match(brief, /must not be spoken/);
  await page.close();
});

test('the live page comes up and asks for a key rather than throwing', async () => {
  const { page, problems } = await open('/demo/live.html');
  assert.deepEqual(problems, [], `console errors:\n${problems.join('\n')}`);
  assert.equal(await page.textContent('#state'), 'not connected');

  // There is no Pages Function in front of this static server, so
  // /api/gemini-token 404s and the page must fall back to asking for a key
  // rather than failing obscurely.
  await page.click('#start');
  await page.waitForSelector('#notice:not([hidden])');
  assert.match(await page.textContent('#notice'), /Gemini API key/);
  assert.equal(await page.textContent('#state'), 'failed');
  await page.close();
});
