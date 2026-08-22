/**
 * Live wiring: a real Gemini Live session driving the three panes.
 *
 * The only thing worth studying is what happens on a tap. It goes through
 * Session.selectOption — the same call a spoken "the second one" makes — and
 * then tells the model with sendSystemNote. The model has no way to tell the
 * two apart, which is the claim; the wire pane prints both actions so you can
 * check it rather than take it.
 */

import { GeminiLive, byteLength } from '../src/live/gemini-live.js';
import { Microphone, Player } from '../src/live/audio.js';
import { mountPanes, node } from './panes.js';

const $ = (id) => document.getElementById(id);
const ui = {
  key: $('key'), forget: $('forget'), start: $('start'), say: $('say'), send: $('send'),
  catalog: $('catalog'), upload: $('upload'), disclosure: $('disclosure'),
  inspect: $('inspect'), setupSummary: $('setupSummary'),
};

const available = await fetch('../catalog/index.json').then((r) => r.json());
let catalog = await fetch(`../catalog/${available[0].file}`).then((r) => r.json());

let live = null;
let mic = null;

const panes = mountPanes({
  catalog,
  // Without this the model is talking about a list whose state it cannot see.
  onTapNote: (index, chose) =>
    live?.sendSystemNote(`[the user tapped option ${index}: ${Object.values(chose)[0]}]`),
});

const player = new Player({
  onStateChange: (s) => panes.setState(s === 'speaking' ? 'speaking' : 'listening', 'on'),
});

// --------------------------------------------------------------------- setup

/** Catalogs dropped in from disk; they are not in catalog/index.json. */
const localCatalogs = new Map();

// There is no setup step in this API — no instance to create, nothing
// registered server-side. "Setup" is one frame at the top of every socket, so
// the closest thing to configuring an agent is choosing what goes in it.

for (const entry of available) {
  ui.catalog.append(node('option', { value: entry.file }, entry.title));
}

ui.catalog.addEventListener('change', async () => {
  const file = ui.catalog.value;
  try {
    swapCatalog(localCatalogs.get(file)
      ?? await fetch(`../catalog/${file}`).then((r) => r.json()));
  } catch (err) {
    panes.warn(`could not load ${file}: ${err.message}`, true);
  }
});

ui.upload.addEventListener('change', async () => {
  const file = ui.upload.files?.[0];
  if (!file) return;
  try {
    swapCatalog(JSON.parse(await file.text()), file.name);
  } catch (err) {
    // A bad catalog throws from grammarOf — duplicate keyword, optional field
    // in the middle — and that message is the useful one, so show it.
    panes.warn(`${file.name}: ${err.message}`, true);
  } finally {
    ui.upload.value = '';
  }
});

ui.disclosure.addEventListener('change', () => {
  if (live) panes.warn('Disclosure changes on the next connect — the setup frame is immutable.');
  describeSetup();
});

ui.inspect.addEventListener('click', () => {
  // Built by GeminiLive itself rather than reassembled here, so what is shown
  // cannot drift from what is sent.
  const probe = new GeminiLive({
    apiKey: 'inspect', catalog, session: panes.session, disclosure: ui.disclosure.value,
  });
  const frame = probe.setupFrame();
  panes.setupFrame(frame, byteLength(JSON.stringify(frame)), 'not sent — inspection only');
});

function swapCatalog(next, label) {
  panes.setCatalog(next);
  catalog = next;
  if (label) {
    // A dropped file is not in the index; give it a row so it can be chosen again.
    const opt = node('option', { value: label, selected: 'selected' }, `${next.title ?? label} (local)`);
    ui.catalog.append(opt);
    ui.catalog.value = label;
    localCatalogs.set(label, next);
  }
  panes.warn(null);
  describeSetup();
}

/** One line saying what the next connect will actually cost. */
function describeSetup() {
  const probe = new GeminiLive({
    apiKey: 'inspect', catalog, session: panes.session, disclosure: ui.disclosure.value,
  });
  const bytes = byteLength(JSON.stringify(probe.setupFrame()));
  const components = Object.values(catalog.components ?? {}).filter((c) => c.express).length;
  ui.setupSummary.textContent =
    `${catalog.title ?? 'catalog'} · ${components} components · ${ui.disclosure.value}`
    + ` · ${bytes} B (~${Math.round(bytes / 4)} tokens) sent on every connect`;
}

// ---------------------------------------------------------------- connection

// The key lives here and only here. Reading it back is a convenience for the
// person testing; nothing else in the page has anywhere to send it.
ui.key.value = localStorage.getItem('gemini-key') ?? '';

ui.forget.addEventListener('click', () => {
  localStorage.removeItem('gemini-key');
  ui.key.value = '';
  ui.key.focus();
  panes.warn('Key removed from this browser.');
});

ui.start.addEventListener('click', async () => {
  if (live) return teardown('stopped');

  const apiKey = ui.key.value.trim();
  if (!apiKey) {
    ui.key.focus();
    return panes.warn('Paste a Gemini API key to start. It stays in this browser.');
  }
  localStorage.setItem('gemini-key', apiKey);

  panes.warn(null);
  panes.setState('connecting…', 'busy');
  ui.start.disabled = true;

  try {
    // Must happen inside the click, or the AudioContext stays suspended and
    // the model ends up talking to a muted speaker.
    await player.prime();

    live = new GeminiLive({
      apiKey, catalog, session: panes.session, disclosure: ui.disclosure.value,
    });
    wire(live);
    await live.connect();

    mic = new Microphone((pcm, level) => {
      live?.sendAudio(pcm);
      panes.level(level * 4);
    });
    const { sampleRate } = await mic.start();
    if (sampleRate !== 16000) console.warn(`mic at ${sampleRate}Hz; resampling to 16000`);

    panes.setState('listening', 'on');
    ui.start.textContent = 'Stop';
    ui.start.classList.replace('primary', 'live');
    ui.say.disabled = ui.send.disabled = false;
  } catch (err) {
    teardown('failed');
    panes.warn(explain(err), true);
  } finally {
    ui.start.disabled = false;
  }
});

function wire(l) {
  l.on('setupSent', ({ frame, bytes }) => panes.setupFrame(frame, bytes));
  l.on('audio', ({ base64 }) => player.play(base64));
  l.on('interrupted', () => {
    player.stop();
    panes.turn('system', 'interrupted — it stopped talking');
  });
  l.on('heard', (t) => panes.append('user', t));
  l.on('said', (t) => panes.append('model', t));
  l.on('tool', ({ name, response }) => {
    if (name === 'select_option') panes.visual.paint();
    else if (name === 'render_surface') panes.briefing(response);
    // `describe` logs itself through Session.onLog, with its full answer.
  });
  l.on('goAway', () => panes.warn('Gemini is about to close this session.', true));
  l.on('close', ({ reason }) => {
    if (!live) return; // our own teardown
    teardown('disconnected');
    if (reason) panes.warn(reason, true);
  });
}

function teardown(state) {
  mic?.stop(); mic = null;
  live?.close(); live = null;
  player.stop();
  panes.level(0);
  ui.start.textContent = 'Start';
  ui.start.classList.replace('live', 'primary');
  ui.say.disabled = ui.send.disabled = true;
  panes.setState(state, state === 'failed' || state === 'disconnected' ? 'err' : '');
}

// -------------------------------------------------------------------- typing

const send = () => {
  const text = ui.say.value.trim();
  if (!text || !live) return;
  live.sendText(text);
  panes.turn('user', text);
  ui.say.value = '';
};
ui.send.addEventListener('click', send);
ui.say.addEventListener('keydown', (e) => { if (e.key === 'Enter') send(); });

panes.setState('not connected');
describeSetup();

function explain(err) {
  const m = String(err?.message ?? err);
  if (/API key not valid|API_KEY_INVALID/i.test(m)) return 'That API key was rejected by Google.';
  if (/unregistered callers/i.test(m)) return 'No credential reached Google — check the key.';
  if (/not found for API version|not supported for bidi/i.test(m)) {
    return 'That model does not serve the Live API for this key.';
  }
  if (/quota|RESOURCE_EXHAUSTED/i.test(m)) return 'Out of Live API quota for this key.';
  if (/NotAllowedError|Permission denied/i.test(m)) return 'Microphone permission denied — allow it in the address bar.';
  return m;
}
