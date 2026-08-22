# There is no setup step

The Live API has no notion of an agent you configure once and then talk to.
No registration, no deployed instance, no ID to come back to. What it has is
**one frame at the top of every WebSocket**:

```js
ws.onopen = () => ws.send(JSON.stringify({
  setup: {
    model, generationConfig,
    systemInstruction: { parts: [{ text: systemInstruction(catalog) }] },
    tools: functionDeclarations(catalog),
  },
}));
```

The session is created on connect and dies with the socket. Nothing on
Google's side remembers that your tools exist.

And it is immutable once acknowledged. Connect, wait for `setupComplete`, send
a second `setup` declaring a different tool, and the server closes the
connection:

```
closed 1007: Request contains an invalid argument.
```

So there is no adding a capability mid-conversation. **Everything the model
may ever do is in that one frame, resent on every connect, or it does not
exist.**

## Which makes catalogs plugins, and plugins expensive

The catalog already behaves like a plugin bundle. One JSON file carries the
components, their grammar, their prompt text and their modality gates, and
`Session` plus `GeminiLive` take nothing else — `demo/live.html` swaps between
`travel` and `clinic` at runtime and gets a different agent, with different
keywords, different fields and different gates, without touching `src/`.

What it cannot do is what Claude Code's skills do. There, dozens of skills can
exist and only their one-line descriptions cost tokens up front; the full
instructions load when a task matches. The Live API has no equivalent, because
of the immutability above.

So `src/express/prompt.js` implements one in userspace:

| mode | the setup frame carries | the model gets syntax by |
|---|---|---|
| `flat` | every component's full signature | already having it |
| `progressive` | keyword + one-line summary only | calling `describe(keyword)` |

`describe` is a third blocking tool. It returns the exact thing the flat
prompt would have carried — signature, field list, which fields are optional,
and a worked example line — for one component.

## Does it work? Yes.

Five prompts, one fresh session each, against
`models/gemini-3.1-flash-live-preview`. Reproduce with
`GEMINI_API_KEY=… node bench/disclosure.mjs`.

| | flat | progressive |
|---|---|---|
| rendered a surface | 5/5 | 5/5 |
| **first attempt parsed** | **5/5** | **5/5** |
| rejections | 0 | 0 |
| `describe` calls | 0 | 8 |
| avg time to first render | 1352 ms | 1178 ms |
| **avg turn** | **5107 ms** | **6250 ms** |
| setup frame | 5402 B | 5387 B |

A model told only that a component named `cards` exists reliably asks what it
is before using it, and then writes correct Express on the first attempt. It
never guessed, and it never had to be corrected. The mechanism works.

## Is it worth it? Not here.

Look at the last row. Progressive disclosure saved **15 bytes** and cost **8
extra round trips and 1.1 seconds per turn**.

For the clinic catalog it is worse than that — it *costs* 35 bytes, because
the instruction telling the model to call `describe` is longer than the
signatures it removed.

The reason is that the setup frame is mostly not component syntax. It is the
fixed preamble: the grammar rules, the two-channels instruction, the worked
examples. At six components, per-component syntax is a rounding error.

`node bench/frame-size.mjs` finds where that stops being true, by generating
catalogs of increasing size:

```
  components   flat      progressive   saved      %
  ----------------------------------------------------
         1     3467 B       3880 B     -413 B  -11.9%
         5     4599 B       4136 B      463 B   10.1%
        10     6014 B       4456 B     1558 B   25.9%
        20     8874 B       5136 B     3738 B   42.1%
        40    14594 B       6496 B     8098 B   55.5%
       120    37534 B      12016 B    25518 B   68.0%
```

## So

**Under ~10 components, use `flat`.** The frame is small, the model has
everything before it speaks, and every turn is a second faster. That is why
`flat` is the default and what the deployed demo uses.

**Above ~20, `progressive` starts to matter** — 42% off the frame at twenty
components, 68% at a hundred and twenty — and the cost stays flat, because a
turn only pays for the components it actually uses. A catalog per vertical, or
one big catalog covering a whole product surface, is where this stops being a
curiosity.

**The latency cost is the real one, not the bytes.** A `describe` round trip
lands inside a live conversation, and voice is the modality where a second
shows. Two things reduce it, neither implemented here: cache the answers
across sessions in the prompt itself for components that always get used, and
put the two or three most common components in flat form while leaving the
long tail behind `describe`. That hybrid is probably the right shape for a
real product, and it is guesswork until someone measures it.

What is not guesswork: the mechanism is sound, the model cooperates with it,
and at the size of these catalogs it is a pure loss. Shipping it as an option
with the numbers attached seemed better than shipping it as a default because
it sounded clever.
