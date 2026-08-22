/**
 * Intermediate representation → A2UI v1.0 messages.
 *
 * This is where all the bookkeeping the model should never have to think
 * about gets done: surface ids, component ids, data-model paths, the root
 * Column and its children array, selection state, and the action descriptor
 * each component fires. Express says `cards pick_flight`; four lines of
 * protocol come out, and they are correct every time because a function
 * wrote them rather than a language model under latency pressure.
 *
 * Message shapes follow the A2UI v1.0 agent→renderer set — `createSurface`,
 * `updateDataModel`, `updateComponents`. Bindings use the same conventions as
 * the sibling a2ui-voice demo (`items: {path}`, `action: {name, contextFields}`,
 * `selectionPath`) so surfaces from both projects can be compared side by side.
 */

/**
 * @param {ReturnType<import('./parse.js').parseExpress>} ir
 * @param {object} catalog
 * @returns {{surfaceId: string, messages: object[], components: object[], dataModel: object}}
 */
export function transpile(ir, catalog) {
  const { surfaceId, nodes } = ir;
  const components = [];
  const dataModel = {};
  const counters = new Map();

  for (const node of nodes) {
    const id = idFor(node, counters);
    const component = { id, component: node.component };

    // Head arguments that are prose land directly on the component.
    if (node.head.text !== undefined) component.text = node.head.text;

    if (node.spec.list) {
      dataModel[id] = { items: node.items, selected: null };
      component.items = { path: `/${id}/items` };
      component.selectionPath = `/${id}/selected`;
    } else if (node.spec.fields.length) {
      // A single-value component: its fields are its properties.
      Object.assign(component, node.items[0] ?? {});
    }

    if (node.head.action) {
      component.action = {
        name: node.head.action,
        // What the renderer attaches when this fires — for a list, resolved
        // against the chosen item; identical whether the choice came from a
        // tap or from "the second one".
        contextFields: node.spec.list ? ['index', ...node.spec.fields.slice(0, 1)] : ['index'],
      };
    }

    const modality = { ...catalog.components?.[node.component]?.modality };
    if (Object.keys(modality).length) component.modality = modality;

    components.push(component);
  }

  const root = {
    id: 'root',
    component: 'Column',
    children: components.map((c) => c.id),
  };

  const messages = [
    { createSurface: { surfaceId, catalogUri: catalog.catalogId } },
  ];
  if (Object.keys(dataModel).length) {
    messages.push({ updateDataModel: { surfaceId, path: '/', contents: dataModel } });
  }
  messages.push({ updateComponents: { surfaceId, components: [root, ...components] } });

  return { surfaceId, messages, components: [root, ...components], dataModel };
}

/**
 * The action name doubles as the component id — it is already unique (the
 * parser enforces that), already meaningful, and it makes the emitted JSON
 * readable, which matters because reading it is the point of the demo.
 */
function idFor(node, counters) {
  if (node.head.action) return node.head.action;
  const n = (counters.get(node.keyword) ?? 0) + 1;
  counters.set(node.keyword, n);
  return `${node.keyword}${n}`;
}

/** How much protocol one line of Express bought. Shown in the demo. */
export function expansion(source, messages) {
  const from = new TextEncoder().encode(source.trim()).length;
  const to = new TextEncoder().encode(JSON.stringify(messages)).length;
  return { from, to, ratio: Number((to / Math.max(from, 1)).toFixed(1)) };
}
