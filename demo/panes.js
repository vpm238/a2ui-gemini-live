/**
 * The three panes, shared by both demos.
 *
 * live.html drives these with a real Gemini Live session; offline.html drives
 * them with a scripted one and no API key. Everything below the wiring — the
 * parser, the transpiler, the gates, the renderer — is identical in both, so
 * the offline demo is a genuine rehearsal rather than a mockup, and the
 * headless test can drive it.
 */

import { Session } from '../src/session.js';
import { VisualRenderer } from '../src/render/visual.js';
import { expansion } from '../src/express/transpile.js';

const $ = (id) => document.getElementById(id);

export function mountPanes({ catalog, onTapNote }) {
  const ui = {
    dot: $('dot'), state: $('state'), level: $('level'), notice: $('notice'),
    turns: $('turns'), screen: $('screen'), wire: $('wire'),
  };

  const session = new Session({
    catalog,
    onSurface: (messages, surface) => {
      visual.show(surface);
      hop('a2ui', 'A2UI v1.0 · transpiler → renderer', `${messages.length} messages`,
        pre(JSON.stringify(messages, null, 2)));
    },
    onAction: ({ event }, { via }) => {
      hop('action', `action · ${via}`, 'renderer → agent', pre(JSON.stringify({ event }, null, 2)));
    },
    onLog: (entry) => {
      if (entry.kind === 'transpile') {
        const { from, to, ratio } = expansion(entry.source, entry.messages);
        hop('express', 'A2UI Express · model → transpiler', 'render_surface', pre(entry.source))
          .append(node('div', { class: 'ratio' },
            node('span', {}, 'wrote'), node('b', {}, `${from} B`),
            node('span', {}, '→ emitted'), node('i', {}, `${to} B`),
            node('span', {}, `· ×${ratio}`)));
      }
      if (entry.kind === 'reject') {
        hop('reject', 'rejected · transpiler → model', `${entry.errors.length} errors`,
          pre(entry.source),
          list(entry.errors.map((e) => `line ${e.line}: ${e.message}${e.hint ? ` — ${e.hint}` : ''}`)));
      }
      if (entry.kind === 'describe') {
        // Only ever seen under progressive disclosure: the model asking for
        // syntax the setup frame deliberately did not carry.
        hop('describe', 'describe · model → catalog', entry.keyword,
          pre(JSON.stringify(entry.response, null, 2)));
      }
    },
  });

  const visual = new VisualRenderer(ui.screen, catalog, (action, index) => {
    const res = session.selectOption(action, index, 'tap');
    if (!res.ok) return;
    visual.paint();
    turn('system', `tapped ${index} · ${Object.values(res.chose)[0]}`);
    onTapNote?.(index, res.chose);
  });
  visual.clear();

  // ------------------------------------------------------------------ panes

  function setState(text, kind = '') {
    ui.state.textContent = text;
    ui.dot.className = `dot ${kind}`;
  }

  function warn(message, bad = false) {
    ui.notice.hidden = !message;
    ui.notice.textContent = message ?? '';
    ui.notice.classList.toggle('bad', bad);
  }

  function level(fraction) {
    ui.level.style.width = `${Math.min(100, Math.max(0, fraction * 100))}%`;
  }

  /** Transcripts stream in fragments; keep appending to the same bubble. */
  let open = null;
  function append(who, text) {
    if (open?.dataset.who !== who) open = null;
    if (!open) open = turn(who, '');
    open.querySelector('p').textContent += text;
    ui.turns.lastElementChild?.scrollIntoView?.({ block: 'nearest' });
  }

  function turn(who, text) {
    open = null;
    const box = node('div', { class: `turn ${who}`, 'data-who': who },
      node('span', { class: 'who' }, who === 'model' ? 'gemini' : who),
      node('p', {}, text));
    ui.turns.append(box);
    box.scrollIntoView?.({ block: 'nearest' });
    return box;
  }

  function hop(kind, title, tag, ...body) {
    const box = node('div', { class: `hop hop-${kind}` },
      node('h3', {}, node('span', {}, title), node('span', { class: 'tag' }, tag)),
      ...body);
    ui.wire.prepend(box);
    while (ui.wire.children.length > 24) ui.wire.lastChild.remove();
    return box;
  }

  function briefing(response) {
    if (!response?.ok || !response.guidance?.length) return;
    hop('brief', 'briefing · transpiler → model', 'tool response',
      list(response.guidance), pre(JSON.stringify({ showing: response.showing }, null, 2)));
  }

  /**
   * The hop the wire pane was missing: the frame that configures the whole
   * session. Everything else in this pane is downstream of it.
   */
  function setupFrame(frame, bytes, note = 'sent on connect') {
    return hop('setup', 'setup · client → Gemini Live', note,
      pre(JSON.stringify(frame, null, 2)),
      node('div', { class: 'ratio' },
        node('span', {}, 'frame'), node('b', {}, `${bytes} B`),
        node('span', {}, `· ~${Math.round(bytes / 4)} tokens · every connect`)));
  }

  /** The whole configuration is this one object; swapping it swaps the agent. */
  function setCatalog(next) {
    session.setCatalog(next);
    visual.catalog = next;
    visual.clear();
    ui.wire.replaceChildren();
    ui.turns.replaceChildren();
  }

  return {
    session, visual, setState, warn, level, append, turn, hop, briefing,
    setupFrame, setCatalog,
  };
}

export const pre = (text) => node('pre', {}, text);
export const list = (items) => node('ul', {}, ...items.map((t) => node('li', {}, t)));

export function node(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  el.append(...children);
  return el;
}
