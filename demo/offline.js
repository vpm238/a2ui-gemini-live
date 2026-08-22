/**
 * The same demo with the model on rails.
 *
 * Every `render` step below is Express text of the kind Gemini actually
 * produced during the live tests, fed through the real parser, transpiler and
 * gates. Only the microphone, the speaker and the model are missing — which
 * makes this the version that can be checked in CI, and the version to look
 * at when you want to read the wire without a key.
 *
 * The script is chosen to hit the four things that are hard: a normal list, a
 * render that fails and is repaired, the three modality gates, and a tap and
 * a spoken pick landing on the identical action.
 */

import { mountPanes } from './panes.js';

const catalog = await fetch('../catalog/travel.catalog.json').then((r) => r.json());
const panes = mountPanes({ catalog });

const SCRIPT = [
  { user: 'find me a direct flight to Lisbon next Friday, back Sunday night, under 300 euros' },
  { said: 'Three come in under three hundred — the cheapest is the early one out.' },
  {
    render: `heading Lisbon · Fri 14 – Sun 16
cards pick_flight
- TAP Air Portugal | 06:15–09:05 | EUR 189 | direct
- easyJet | 11:40–14:25 | EUR 212 | direct
- Ryanair | 19:05–21:50 | EUR 244 | 1 stop
note Prices held for 20 minutes`,
  },

  { user: 'the second one' },
  { select: ['pick_flight', 2], said: 'easyJet it is.' },

  { user: 'can I see where the seats are' },
  {
    // A component the catalog marks requiresVisual: the briefing tells the
    // model not to describe it, because a spoken seat map is invented detail.
    render: `heading easyJet · seats left
seatmap choose_seat
- 14A | window | EUR 12
- 14B | middle | EUR 8
- 22C | aisle, exit row | EUR 19`,
    said: 'Three left worth having — they are on the screen.',
  },

  { user: 'show me a price chart for the month first' },
  {
    // There is no chart in the catalog, so there is no keyword for one. The
    // model finds this out from the tool result, not from a refusal.
    render: `heading Lisbon prices
chart price_history | month
- Aug | EUR 189`,
  },
  {
    render: `heading Lisbon · Fri 14 – Sun 16
note Prices for this route have moved between EUR 180 and EUR 260 this month`,
    said: 'No chart on this screen, but the range has been one-eighty to two-sixty.',
  },

  { user: 'ok book the easyJet one' },
  {
    // stakes: readback. The briefing names which fields may be spoken — and,
    // just as importantly, which may not.
    render: 'confirm pay_now | easyJet · Fri 11:40 to Lisbon | EUR 212.00 | Visa ending 4417',
    said: 'Two hundred and twelve euros for the easyJet, Friday eleven forty. Say confirm and I will book it.',
  },

  { user: 'what details do you have on file' },
  {
    // spokenSensitive: rendered in full, never enumerated in the briefing.
    render: `private
- Passport | PT 4417 8890
- Frequent flyer | TP 99120
- Home address | Rua do Alecrim 12, Lisboa`,
    said: 'They are on the screen — I will not read those out.',
  },
];

let cursor = 0;
let playing = null;

const ui = {
  step: document.getElementById('step'),
  play: document.getElementById('play'),
  reset: document.getElementById('reset'),
};

function step() {
  if (cursor >= SCRIPT.length) {
    panes.setState('end of script');
    ui.step.disabled = true;
    return false;
  }
  const beat = SCRIPT[cursor];
  cursor += 1;

  if (beat.user) {
    panes.turn('user', beat.user);
    panes.setState('heard', 'on');
  }
  if (beat.render) {
    panes.setState('rendering', 'busy');
    panes.briefing(panes.session.renderSurface(beat.render));
  }
  if (beat.select) {
    panes.session.selectOption(beat.select[0], beat.select[1], 'voice');
    panes.visual.paint();
  }
  if (beat.said) {
    panes.turn('model', beat.said);
    panes.setState('speaking', 'on');
  }
  return true;
}

ui.step.addEventListener('click', step);

ui.play.addEventListener('click', () => {
  if (playing) {
    clearInterval(playing);
    playing = null;
    ui.play.textContent = 'Play all';
    return;
  }
  ui.play.textContent = 'Pause';
  playing = setInterval(() => {
    if (!step()) {
      clearInterval(playing);
      playing = null;
      ui.play.textContent = 'Play all';
    }
  }, 1400);
});

ui.reset.addEventListener('click', () => {
  clearInterval(playing);
  playing = null;
  cursor = 0;
  ui.play.textContent = 'Play all';
  ui.step.disabled = false;
  document.getElementById('turns').replaceChildren();
  document.getElementById('wire').replaceChildren();
  panes.session.surface = null;
  panes.visual.clear();
  panes.setState('ready');
});

panes.setState('ready');

// Let the headless test drive the same buttons a person would.
globalThis.__script = { step, length: SCRIPT.length };
