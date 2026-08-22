/**
 * The three modality gates, and the one thing that is different here.
 *
 * In the sibling a2ui-voice demo the agent produced both the sentence and the
 * surface, so the renderer could read the gates and simply decline to speak.
 * Here the model owns the microphone: audio is already streaming by the time
 * a surface exists. The renderer cannot take words back.
 *
 * What it can do is answer the tool call *before* the model gets to the next
 * sentence — which is why render_surface is declared blocking. So the gates
 * stop being a veto and become a briefing: the return value of the tool tells
 * the model what is on screen and what it may not say about it.
 *
 * That is strictly weaker than a veto and this file should not pretend
 * otherwise. It is an instruction, and instructions get ignored. See
 * docs/GATES.md for where that leaves the proposal.
 *
 * One thing does get better. In a2ui-voice `spokenSensitive` guarded whole
 * components, while sensitivity is really a property of *fields* — which is
 * how a readback ended up speaking a card number. Here the catalog's
 * `speech.readback` template names the fields that may be spoken, and every
 * other field on the component is named in the guidance as forbidden. The
 * transpiler knows the field names, so the gate can finally talk about them.
 */

export const DEFAULT_MODALITY = Object.freeze({
  requiresVisual: false,
  stakes: 'none',
  spokenSensitive: false,
});

export function modalityOf(component, catalog) {
  const fromCatalog = catalog?.components?.[component.component]?.modality;
  return { ...DEFAULT_MODALITY, ...(fromCatalog ?? {}), ...(component.modality ?? {}) };
}

const RANK = { none: 0, confirm: 1, readback: 2 };

/**
 * Everything the model needs to know about the surface it just put up.
 *
 * @param {{components: object[], dataModel: object, surfaceId: string}} surface
 * @param {object} catalog
 */
export function brief(surface, catalog) {
  const notes = [];
  const options = {};
  let stakes = 'none';

  for (const component of surface.components) {
    if (component.component === 'Column') continue;
    const gates = modalityOf(component, catalog);
    const speech = catalog.components?.[component.component]?.speech ?? {};
    const data = surface.dataModel[component.id];

    if (RANK[gates.stakes] > RANK[stakes]) stakes = gates.stakes;

    if (data?.items) {
      const spoken = data.items.map((item, i) => `${i + 1} ${fill(speech.item, item) || firstValue(item)}`);
      options[component.id] = data.items.length;
      if (!gates.spokenSensitive) {
        notes.push(`"${component.id}" is numbered 1–${data.items.length}: ${spoken.join('; ')}.`);
      }
    }

    if (gates.requiresVisual) {
      notes.push(
        `"${component.id}" cannot be conveyed in speech. Tell the user to look at the screen; ` +
        'do not describe or invent any of its detail aloud.',
      );
    }

    if (gates.spokenSensitive) {
      notes.push(
        `"${component.id}" holds private values. They are on screen and must not be spoken. ` +
        'Refer to it as "the details on screen".',
      );
    }

    if (gates.stakes === 'readback') {
      const speakable = fieldsIn(speech.readback);
      const forbidden = Object.keys(component)
        .filter((k) => !RESERVED.has(k) && !speakable.includes(k));
      notes.push(
        `"${component.id}" commits money. Read back ${speakable.length ? speakable.join(' and ') : 'the essentials'} ` +
        `and wait for an explicit yes.` +
        (forbidden.length ? ` Do not say ${forbidden.join(' or ')} aloud.` : ''),
      );
    } else if (gates.stakes === 'confirm') {
      notes.push(`"${component.id}" needs a yes or no before it takes effect.`);
    }
  }

  return { stakes, options, notes };
}

/** Component keys that are protocol, not content. */
const RESERVED = new Set(['id', 'component', 'items', 'action', 'selectionPath', 'modality', 'children']);

/** `"{title}, {when}"` + item → `"easyJet, 11:40–14:25"`. Missing field ⇒ null. */
function fill(template, item) {
  if (!template) return null;
  let ok = true;
  const out = template.replace(/\{(\w+)\}/g, (_, key) => {
    if (item[key] === undefined) { ok = false; return ''; }
    return item[key];
  });
  return ok ? out : null;
}

function fieldsIn(template) {
  return [...String(template ?? '').matchAll(/\{(\w+)\}/g)].map((m) => m[1]);
}

function firstValue(item) {
  return Object.values(item)[0] ?? '';
}
