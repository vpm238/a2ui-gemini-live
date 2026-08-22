/**
 * The screen half of the surface.
 *
 * It dispatches on the SHAPE of a component, not on its name: anything with
 * `items` is a list, anything with `text` is a line, anything else with plain
 * string properties is a panel. A catalog can therefore add `HotelCards` or
 * `TrainTimes` and get a sensible rendering without this file changing —
 * which is the same property the transpiler has, and for the same reason.
 *
 * The two exceptions are deliberate and both are modality, not type:
 * `requiresVisual` gets a marker saying speech cannot carry it, and
 * `spokenSensitive` gets one saying it is on screen only. Those come from the
 * catalog's gates, so they are declared once per component type rather than
 * hard-coded here.
 */

import { modalityOf } from './gates.js';

export class VisualRenderer {
  /**
   * @param {HTMLElement} root
   * @param {object} catalog
   * @param {(action: string, index: number) => void} onTap  1-based index
   */
  constructor(root, catalog, onTap) {
    this.root = root;
    this.catalog = catalog;
    this.onTap = onTap;
    this.surface = null;
  }

  clear() {
    this.surface = null;
    this.root.replaceChildren(el('p', { class: 'empty' }, 'Nothing on screen yet.'));
  }

  show(surface) {
    this.surface = surface;
    this.paint();
  }

  /** Re-read the data model and repaint. Selection is local, so this is cheap. */
  paint() {
    if (!this.surface) return this.clear();
    const { components, dataModel } = this.surface;
    const byId = new Map(components.map((c) => [c.id, c]));
    const root = components.find((c) => c.component === 'Column') ?? { children: [] };

    const nodes = root.children
      .map((id) => byId.get(id))
      .filter(Boolean)
      .map((component) => this.#component(component, dataModel[component.id]));

    this.root.replaceChildren(...nodes);
  }

  #component(component, data) {
    const gates = modalityOf(component, this.catalog);
    const box = el('section', { class: `c c-${component.component.toLowerCase()}` });

    if (gates.requiresVisual) box.append(marker('screen only', 'speech cannot carry this'));
    if (gates.spokenSensitive) box.append(marker('never spoken', 'shown here, never read aloud'));
    if (gates.stakes === 'readback') box.append(marker('readback', 'must be restated before it commits'));

    if (component.text !== undefined) {
      box.append(el('p', { class: 'text' }, component.text));
      return box;
    }

    if (data?.items) {
      box.append(el('ol', { class: 'items' }, ...data.items.map((item, i) =>
        this.#item(component, item, i, data.selected === i, gates))));
      return box;
    }

    box.append(el('dl', { class: 'panel' }, ...fieldsOf(component).flatMap(([k, v]) => [
      el('dt', {}, k),
      el('dd', {}, v),
    ])));
    if (component.action) {
      box.append(el('button', {
        class: 'commit',
        onclick: () => this.onTap?.(component.action.name, 1),
      }, 'Confirm'));
    }
    return box;
  }

  #item(component, item, index, selected, gates) {
    const values = Object.values(item);
    const selectable = Boolean(component.action);

    const node = el(selectable ? 'button' : 'div', {
      class: `item${selected ? ' is-selected' : ''}${gates.spokenSensitive ? ' is-private' : ''}`,
      ...(selectable && {
        'aria-pressed': String(selected),
        onclick: () => this.onTap?.(component.action.name, index + 1),
      }),
    });

    if (selectable) node.append(el('span', { class: 'n' }, String(index + 1)));
    node.append(el('span', { class: 'lead' }, values[0] ?? ''));
    if (values.length > 1) {
      node.append(el('span', { class: 'rest' }, values.slice(1).join(' · ')));
    }
    return node;
  }
}

/** Component keys that are protocol rather than content. */
const RESERVED = new Set(['id', 'component', 'items', 'action', 'selectionPath', 'modality', 'children', 'text']);

function fieldsOf(component) {
  return Object.entries(component).filter(([k, v]) => !RESERVED.has(k) && typeof v === 'string');
}

function marker(label, title) {
  return el('span', { class: `marker m-${label.split(' ')[0]}`, title }, label);
}

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2), value);
    else if (value !== undefined && value !== null) node.setAttribute(key, value);
  }
  node.append(...children.filter((c) => c !== null && c !== undefined));
  return node;
}
