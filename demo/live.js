/**
 * Live wiring: a real Gemini Live session driving the three panes.
 *
 * The only thing worth studying is what happens on a tap. It goes through
 * Session.selectOption — the same call a spoken "the second one" makes — and
 * then tells the model with sendSystemNote. The model has no way to tell the
 * two apart, which is the claim; the wire pane prints both actions so you can
 * check it rather than take it.
 */

import { GeminiLive } from '../src/live/gemini-live.js';
import { Microphone, Player } from '../src/live/audio.js';
import { mountPanes } from './panes.js';

const $ = (id) => document.getElementById(id);
const ui = { key: $('key'), start: $('start'), say: $('say'), send: $('send') };

const catalog = await fetch('../catalog/travel.catalog.json').then((r) => r.json());

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

// ---------------------------------------------------------------- connection

ui.key.value = localStorage.getItem('gemini-key') ?? '';

ui.start.addEventListener('click', async () => {
  if (live) return teardown('stopped');

  panes.warn(null);
  panes.setState('connecting…', 'busy');
  ui.start.disabled = true;

  try {
    // Must happen inside the click, or the AudioContext stays suspended and
    // the model ends up talking to a muted speaker.
    await player.prime();

    live = new GeminiLive({ ...await credential(), catalog, session: panes.session });
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

/**
 * Prefer a token the server minted; fall back to a key typed into the page.
 *
 * Minting happens here, on the click, and not a moment earlier: an ephemeral
 * token's `newSessionExpireTime` is one minute, and it is single-use. A token
 * fetched on page load is usually dead by the time anyone presses Start.
 */
async function credential() {
  const token = await mintToken();
  if (token) {
    ui.key.value = '';
    ui.key.disabled = true;
    ui.key.placeholder = 'using a token minted by this server';
    return { token };
  }

  const apiKey = ui.key.value.trim();
  if (!apiKey) throw new Error('NO_CREDENTIAL');
  localStorage.setItem('gemini-key', apiKey);
  return { apiKey };
}

/** Absent when running from a file:// tree or a deployment with no secret. */
async function mintToken() {
  try {
    const res = await fetch('/api/gemini-token', { method: 'POST' });
    if (!res.ok) return null; // 404 = no Function, 501 = no GEMINI_API_KEY
    return (await res.json())?.token ?? null;
  } catch {
    return null;
  }
}

function wire(l) {
  l.on('audio', ({ base64 }) => player.play(base64));
  l.on('interrupted', () => {
    player.stop();
    panes.turn('system', 'interrupted — it stopped talking');
  });
  l.on('heard', (t) => panes.append('user', t));
  l.on('said', (t) => panes.append('model', t));
  l.on('tool', ({ name, response }) => {
    if (name === 'select_option') panes.visual.paint();
    else panes.briefing(response);
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

function explain(err) {
  const m = String(err?.message ?? err);
  if (m === 'NO_CREDENTIAL') {
    return 'This deployment mints no token, so paste a Gemini API key. It stays in this browser.';
  }
  if (/API key not valid|API_KEY_INVALID/i.test(m)) return 'That API key was rejected by Google.';
  if (/unregistered callers/i.test(m)) return 'No credential reached Google — check the key.';
  if (/not found for API version|not supported for bidi/i.test(m)) {
    return 'That model does not serve the Live API for this key.';
  }
  if (/quota|RESOURCE_EXHAUSTED/i.test(m)) return 'Out of Live API quota for this key.';
  if (/NotAllowedError|Permission denied/i.test(m)) return 'Microphone permission denied — allow it in the address bar.';
  return m;
}
