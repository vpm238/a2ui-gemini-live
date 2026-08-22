# A2UI Express v0.1

A shorthand a language model can write while it is talking, and a function can
expand into A2UI v1.0 without guessing.

## The shape of it

```
surface flights
heading Lisbon · Fri 14 – Sun 16
cards pick_flight
- TAP Air Portugal | 06:15–09:05 | EUR 189 | direct
- easyJet | 11:40–14:25 | EUR 212 | direct
- Ryanair | 19:05–21:50 | EUR 244 | 1 stop
note Prices held for 20 minutes
```

Seven lines, 245 bytes. It transpiles to three A2UI messages, 1,021 bytes,
including the data model, the bindings and the action descriptor.

## Rules

1. **One component per line.** The first word is the keyword.
2. **`-` continues the list above it.** One item per line.
3. **`|` separates fields.** Whitespace around it is ignored; a trailing pipe
   is forgiven.
4. **Blank lines and `#` comments are ignored.**
5. **Nothing nests and nothing is quoted.** There are no delimiters to balance.
6. **`surface <name>` is optional** and must come first. Defaults to `main`.

Rules 1, 2 and 5 are the design. A model streaming tokens under live-audio
latency gets two things wrong reliably: unbalanced delimiters and indentation.
Express has neither, so the failure modes that remain are ones the parser can
name precisely — a wrong field count, an unknown keyword — rather than a
syntax error somewhere in a 40-line blob.

## Where the keywords come from

Nowhere in this document. They come from the catalog:

```json
"OptionCards": {
  "express": {
    "keyword": "cards",
    "head": ["action"],
    "list": true,
    "fields": ["title", "when", "price", "tag"]
  }
}
```

`grammarOf()` reads that into the parser's keyword table, `systemInstruction()`
renders it into the prompt as `cards <action>` plus its item line, and
`transpile()` uses it to decide what to emit. Three consumers, one declaration.

A component with `"express": null` — `Column`, here — is structural: the
transpiler creates it, and there is no way to write one.

### `head`

The words after the keyword, before any pipe.

- `head: ["text"]` is special: the rest of the line is prose, pipes included.
  `heading Lisbon | Porto` is a heading whose text contains a pipe.
- `head: ["action"]` takes one identifier matching `/^[a-z][a-z0-9_]*$/`. It
  becomes the component id, the event name, and the root of its data-model
  paths — which is why it must be unique within a surface.
- `head: []` takes nothing.

### `fields` and `list`

- `list: true` — values arrive on `-` lines beneath. Zero items is an error.
- `list` absent — values arrive inline after the head, pipe-separated, and
  become properties of the component.

## What the transpiler adds

Everything the model should never have to think about.

| Express | A2UI |
|---|---|
| `cards pick_flight` | `id: "pick_flight"`, `component: "OptionCards"` |
| the `-` lines | `dataModel["pick_flight"].items` |
| — | `items: { path: "/pick_flight/items" }` |
| — | `selectionPath: "/pick_flight/selected"`, seeded `null` |
| — | `action: { name: "pick_flight", contextFields: ["index", "title"] }` |
| — | `modality` copied from the catalog |
| line order | the root `Column` and its `children` array |
| — | `createSurface` with the catalog URI |

`contextFields` is what the renderer instantiates when a choice is made — from
a tap or from "the second one", identically. That equivalence is asserted in
both `test/express.test.mjs` and `test/browser.test.mjs`, the second by
clicking a real card in a real browser.

## Errors

The parser never throws and never stops at the first problem. Every error
carries a line number, what was wrong, and what to do:

```
line 2: "chart" is not a component in this catalog
        — available: heading, cards, seatmap, confirm, private, note
line 4: expected 4 fields, found 2
        — `cards` items are: title | when | price | tag
```

All of them go back in one tool response, so a repair costs one round trip
rather than one per mistake. One suppression is deliberate: a list whose item
lines all failed does not *also* get told it is empty — that is a consequence
of the errors above it, not a second mistake, and models chase every line they
are given.

## Deliberately absent

- **Nesting.** No layout, no rows inside columns. A surface is a flat list of
  components, which is enough for one decision and is all a voice-first
  surface should be showing.
- **Styling.** Not the model's business. The catalog and the renderer own it.
- **Data binding expressions.** The transpiler derives every path. There is
  nothing for the model to point at incorrectly.
- **Conditionals and loops.** The model already knows what it wants to show;
  a template language would only let it be wrong about it.

Each of these is a thing Gemini invented unprompted in the first probe. They
are omitted because a surface that needs them is a page, and a page is the
thing this whole line of work is arguing against.
