/**
 * The bit between the model and the screen.
 *
 * Everything here is transport-free and DOM-free on purpose: the browser demo
 * and the headless test in test/live.test.mjs drive the identical object, so
 * what CI proves is what the page does. It owns the current surface, turns a
 * tool call into A2UI messages, and turns a choice — however it was made —
 * into one action.
 */

import { parseExpress } from './express/parse.js';
import { transpile, expansion } from './express/transpile.js';
import { describeComponent } from './express/prompt.js';
import { brief } from './render/gates.js';

export class Session {
  /**
   * @param {object} options
   * @param {object} options.catalog
   * @param {(messages: object[], surface: object) => void} [options.onSurface]
   * @param {(action: object) => void} [options.onAction]
   * @param {(entry: object) => void} [options.onLog]
   */
  constructor({ catalog, onSurface, onAction, onLog } = {}) {
    if (!catalog) throw new Error('Session needs a catalog');
    this.catalog = catalog;
    this.onSurface = onSurface;
    this.onAction = onAction;
    this.onLog = onLog;
    this.surface = null;
  }

  /**
   * Swap the catalog. Everything downstream reads `this.catalog` at call time,
   * so this really is the whole change — different keywords, different fields,
   * different gates, same code. Any surface already up belonged to the old
   * catalog and is dropped rather than reinterpreted under the new one.
   */
  setCatalog(catalog) {
    if (!catalog) throw new Error('setCatalog needs a catalog');
    this.catalog = catalog;
    this.surface = null;
  }

  /**
   * `describe`. Only reachable in progressive disclosure, where the setup
   * frame carries keywords but not syntax — this is how the model gets the
   * rest, one component at a time, when it decides it needs it.
   */
  describe(keyword) {
    const out = describeComponent(this.catalog, keyword);
    this.onLog?.({ kind: 'describe', keyword, response: out });
    return out;
  }

  /**
   * `render_surface`. Returns the value to hand straight back to the model.
   *
   * On failure it returns the errors rather than throwing, because the model
   * is the one who has to fix them — and it gets every error at once so the
   * repair costs one round trip instead of one per mistake.
   */
  renderSurface(express) {
    const source = String(express ?? '');
    const ir = parseExpress(source, this.catalog);

    if (ir.errors.length) {
      this.onLog?.({ kind: 'reject', source, errors: ir.errors });
      return {
        ok: false,
        rendered: false,
        errors: ir.errors.map((e) => `line ${e.line}: ${e.message}${e.hint ? ` — ${e.hint}` : ''}`),
        hint: 'Fix these lines and call render_surface again. Say nothing about this to the user.',
      };
    }

    const out = transpile(ir, this.catalog);
    const briefing = brief(out, this.catalog);
    this.surface = { ...out, express: source };

    this.onLog?.({
      kind: 'transpile',
      source,
      messages: out.messages,
      ...expansion(source, out.messages),
    });
    this.onSurface?.(out.messages, this.surface);

    return {
      ok: true,
      rendered: true,
      surface: out.surfaceId,
      showing: briefing.options,
      guidance: briefing.notes,
    };
  }

  /**
   * `select_option`, and also what the visual renderer calls on a tap.
   *
   * Both paths land here, so both emit the same action object — which is the
   * claim the whole design rests on: the agent cannot tell whether the user
   * pointed or spoke, and does not need to.
   *
   * @param {string} action  the component's action name
   * @param {number} index   1-based, as the user counts
   * @param {'voice'|'tap'} via
   */
  selectOption(action, index, via = 'voice') {
    if (!this.surface) {
      return { ok: false, errors: ['nothing is on screen yet'] };
    }
    const component = this.surface.components.find((c) => c.action?.name === action);
    if (!component) {
      const available = this.surface.components.filter((c) => c.action).map((c) => c.action.name);
      return {
        ok: false,
        errors: [`no component named "${action}" is on screen`],
        hint: available.length ? `on screen: ${available.join(', ')}` : 'nothing selectable is on screen',
      };
    }

    const items = this.surface.dataModel[component.id]?.items ?? [];
    const zero = Number(index) - 1;
    if (!Number.isInteger(zero) || zero < 0 || zero >= items.length) {
      return {
        ok: false,
        errors: [`"${action}" has ${items.length} options; ${index} is not one of them`],
      };
    }

    // Two-way binding is local: the selection is visible before anything
    // crosses a network boundary, whether it was tapped or spoken.
    this.surface.dataModel[component.id].selected = zero;

    const item = items[zero];
    const context = {};
    for (const field of component.action.contextFields ?? []) {
      context[field] = field === 'index' ? zero : item[field];
    }
    const event = { name: action, context };

    this.onLog?.({ kind: 'action', via, event });
    this.onAction?.({ event }, { component, index: zero, item, via });

    return { ok: true, chose: item, index: Number(index), via };
  }

  /** Dispatch a Gemini function call by name. */
  call(name, args = {}) {
    if (name === 'render_surface') return this.renderSurface(args.express);
    if (name === 'select_option') return this.selectOption(args.action, args.index, 'voice');
    if (name === 'describe') return this.describe(args.keyword);
    return { ok: false, errors: [`unknown tool "${name}"`] };
  }
}
