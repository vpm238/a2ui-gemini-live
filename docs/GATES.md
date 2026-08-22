# The modality gates when the model owns the microphone

Three declarations, set once per component type in the catalog:

```json
"modality": {
  "requiresVisual": false,
  "stakes": "readback",
  "spokenSensitive": false
}
```

They decide whether to speak at all. They never supply words. That is the
whole proposal, and it is unchanged from the pipeline architecture it came
from. What changes here is **who can enforce it**.

## What was lost

In a pipeline — one model writing both a sentence and a surface, a renderer
speaking the sentence — the gates are a veto. The renderer holds the text,
reads the gates, and declines. `spokenSensitive` means the words are never
sent to the speech engine. Nothing is trusted; something is prevented.

Gemini Live is not a pipeline. Audio is generated natively and streams as it
is produced, so by the time a surface exists the model has usually been
talking for a second or two. There is no text to withhold. The renderer cannot
un-say anything.

So the gates stop being a veto and become **a briefing**.

## Where they stand instead

Both tools are declared blocking — no `behavior: NON_BLOCKING` on either
function declaration. That is the only structural decision in this repo that
the gates depend on. A blocking call means the model waits for the tool result
before continuing, which creates a moment — after the surface exists, before
the next sentence — where the renderer gets to say something and be heard.

So `render_surface` returns this:

```json
{
  "ok": true,
  "showing": { "pick_flight": 3 },
  "guidance": [
    "\"pick_flight\" is numbered 1–3: 1 TAP Air Portugal, 06:15–09:05, EUR 189; …",
    "\"pay_now\" commits money. Read back summary and amount and wait for an explicit yes. Do not say method aloud."
  ]
}
```

Made asynchronous, that guidance would arrive after the sentence it was meant
to govern. The gates would still be computed and would still be useless.

**This is weaker and the repo should not pretend otherwise.** It is an
instruction in a context window. A model can ignore it, and at some rate will.
For a travel demo that is a bad sentence. For the automotive case that
motivated the gates in the first place — driver distraction, homologation —
"the model was asked not to" is not a control, and this architecture cannot
offer one. That is a real argument against Gemini Live for that use case, not
a gap to be closed by better prompting.

## What was gained

One thing genuinely improved, and it is the hole the previous project found in
its own proposal.

There, `spokenSensitive` guarded **components**, but sensitivity is a property
of **data**. A `PaymentConfirm` was not marked sensitive — it is meant to be
read back — so the readback gate fired and the renderer dutifully said:

> "…eighty-nine euros ninety, charged to the Visa ending 4417. Confirm?"

The gate was satisfied. The card number was spoken anyway. Nothing in the
component-level declaration could have caught it, because the component was
supposed to be spoken; only one of its fields was not.

Express closes most of that, because the transpiler knows the field names. The
catalog carries a speech template naming what may be said:

```json
"PaymentConfirm": {
  "express": { "keyword": "confirm", "head": ["action"],
               "fields": ["summary", "amount", "method"] },
  "speech":   { "readback": "{summary}, {amount}" },
  "modality": { "stakes": "readback" }
}
```

`brief()` takes the fields in the template as speakable and everything else on
the component as forbidden, then says so by name:

> `"pay_now"` commits money. Read back **summary and amount** and wait for an
> explicit yes. **Do not say method aloud.**

Nobody wrote "method" into a rule. It is forbidden because it is a field that
the speech template does not mention — so a new field added to the catalog is
silent by default, and becomes speakable only by being named. That is the
right direction for a default to fall.

The same mechanism keeps `speech.item` honest: the numbering in the briefing
uses `{title}, {when}, {price}` and never mentions `tag`, so a field can exist
on screen without entering the spoken channel at all. `test/express.test.mjs`
asserts both, and asserts that a `spokenSensitive` list is never enumerated in
a briefing even once — the values do not reach the model's context, so they
cannot be leaked from it.

## Where that leaves the proposal

Unchanged as a spec: three declarations, in the catalog, next to the
accessibility attributes that already live there. `requiresVisual`, `stakes`,
`spokenSensitive`. Gates, not scripts.

What these two projects together show is that the *enforcement* is
architectural, not protocol-level:

| | pipeline (agent writes the words) | native audio (model speaks) |
|---|---|---|
| gates are | a veto | a briefing |
| enforced by | the renderer, before speech | the model, if it complies |
| field-level sensitivity | not expressible | expressible, still advisory |
| offline | possible | no |

A spec cannot choose between those. It can only make sure both have the same
three words to argue with — which is the case for putting `modality` in the
protocol rather than in one vendor's renderer.
