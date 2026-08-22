# A2UI Express

**Gemini Live talks and draws in the same turn — because the drawing is a
function call, and the function call is a language small enough to say.**

```
cards pick_flight
- TAP Air Portugal | 06:15–09:05 | EUR 189 | direct
- easyJet | 11:40–14:25 | EUR 212 | direct
- Ryanair | 19:05–21:50 | EUR 244 | 1 stop
```

That is the whole payload the model writes. A transpiler turns it into A2UI
v1.0 — surface, components, data model, bindings, action descriptors, ids —
and hands back a one-paragraph briefing about what is now on screen. The model
never sees a brace.

Two demos, one code path:

| | |
|---|---|
| `demo/live.html` | a real Gemini Live session. Bring your own Gemini API key. |
| `demo/offline.html` | the same turn scripted. No key, no microphone. |

---

## Why this exists

Gemini Live cannot return text and audio in the same session. `responseModalities`
takes exactly one value, and every model currently serving `bidiGenerateContent`
is native-audio, so the only legal value is `AUDIO` — ask for `TEXT` and the
socket closes with a 1007. So "speak and emit UI at once" is not two response
modalities. It is **one audio stream plus one function call**, and the function
call has to carry the UI.

The obvious move is to have the model emit A2UI JSON as the function argument.
That works badly: A2UI is verbose, the model is generating under live-audio
latency pressure, and every byte of protocol is a byte it could get wrong. So
the model writes something much smaller, and a function expands it.

Before writing the grammar I checked what happens without one — a tool called
`render_surface` taking a string called `express`, no further guidance. Gemini
invented an entire markup language on the spot: YAML front-matter, an XML
template body, `<foreach>`, `${}` interpolation, inline CSS. Confident,
coherent, and unparseable by anything.

A model handed a slot will fill the slot. The grammar has to come with it.

## How it holds together

The catalog is the only source of truth. `catalog/travel.catalog.json` gives
each component an `express` block — a keyword, its head arguments, its item
fields — and three things are generated from it:

```
                    ┌─ the parser's keyword table      src/express/parse.js
catalog ────────────┼─ the grammar shown to the model  src/express/prompt.js
                    └─ the shape emitted as A2UI       src/express/transpile.js
```

Add a component and it gains a syntax, a prompt entry and a transpilation in
one edit. Remove it and every line naming it stops parsing. There is no second
place to keep in sync, and no way to describe to the model a component the
parser will not accept.

This is weaker than the guarantee in the sibling project, and worth being
precise about. There, the catalog compiled into the model's structured-output
schema, so an unapproved component was *ungeneratable*. The Live API has no
`responseSchema` — a function declaration's `parameters` is the only schema
lever, and here the parameter is one string. So an unapproved component is
merely *unparseable*: the model can write `chart price_history`, and it is
rejected with a line number rather than prevented. One extra round trip, not a
guarantee. `demo/offline.html` walks through exactly that beat.

## The gates, and what changed

Three declarations per component type, carried in the catalog:

| gate | means |
|---|---|
| `requiresVisual` | speech cannot carry this. Do not describe it; ask them to look. |
| `stakes` | `none` · `confirm` · `readback` — how careful the commit must be. |
| `spokenSensitive` | renders in full, is never read aloud. |

In the sibling project the agent wrote both the sentence and the surface, so
the renderer could read the gates and simply decline to speak. Here the model
owns the microphone: audio is already streaming by the time a surface exists,
and the renderer cannot take words back.

What it can do is answer *before the next sentence*. Both tools are declared
blocking — no `behavior: NON_BLOCKING` — so the model waits for the tool
result, and the result is a briefing:

```
"pay_now" commits money. Read back summary and amount and wait for an
explicit yes. Do not say method aloud.
```

That is an instruction, not a veto, and instructions get ignored. See
[docs/GATES.md](docs/GATES.md) — including the one thing that genuinely got
*better*, which is that the gate can finally name individual fields.

## Running it

```sh
node --test 'test/express.test.mjs'   # 35 tests, no network
node --test 'test/browser.test.mjs'   # 9 tests, headless Chromium
GEMINI_API_KEY=… node --test 'test/live.test.mjs'   # 4 tests, real model

npx http-server . -p 8080             # then open /demo/offline.html
```

`test/live.test.mjs` is the only test that can be wrong about anything: it
puts a real model in front of the generated prompt and asks whether a machine
that has never seen A2UI Express can write it correctly. Currently it can —
first attempt, no repair — and it renders while it is still talking. It has
already earned its keep once: it caught `cards` demanding a departure time
from a hotel, which no unit test of mine would ever have thought to try.

Everything else is a closed loop and proves only internal consistency.

## What is verified, and what is not

Verified against `models/gemini-3.1-flash-live-preview`:

- audio out and a `render_surface` call in the same turn (21 chunks / 166 KB / 4.9 s)
- Express written from the generated prompt alone, parsing on the first attempt
- every render attempt either parsing or returning line-numbered errors; when
  the model does overreach, it repairs inside the same turn
- the briefing reaching the model before it speaks again

Verified in headless Chromium against the scripted demo: the module graph, the
rendered surface, a card that can actually be clicked, and a tapped pick and a
spoken pick producing byte-identical actions.

**Not verified:** a full-duplex session from a browser with a real microphone.
This was built in a sandbox whose browser has no audio devices and no route to
`generativelanguage.googleapis.com`; the live tests run from Node instead. The
audio path in `src/live/audio.js` — worklet capture, resampling, 24 kHz
scheduled playback, barge-in — is therefore the least-tested code here.

**Also not real:** there is no booking backend. The model invents plausible
flights anchored on the catalog's examples.

## Deploying

Pushing to `main` runs the tests and, if they pass, deploys the whole repo to
Cloudflare Pages. There is no build step — the demos import `../src/*.js` as
ES modules at runtime, so the deployed files *are* the source.

Two secrets under **Settings → Secrets and variables → Actions**:

| secret | |
|---|---|
| `CLOUDFLARE_API_TOKEN` | needs the **Cloudflare Pages: Edit** permission |
| `CLOUDFLARE_ACCOUNT_ID` | right-hand sidebar of any Cloudflare dashboard page |

The workflow creates the Pages project if it does not exist, then deploys.
No Gemini credential is involved, because the deployment does not hold one.

## The key

`demo/live.html` is bring-your-own-key. The viewer pastes theirs, it is kept
in that browser's `localStorage`, and it travels in the WebSocket URL to
Google — browsers cannot set headers on a WebSocket handshake, so a query
parameter is the only option. **Forget** clears it.

There is no server in this path. The page is static files on a CDN; there is
nowhere for a key to be sent even in principle, and no shared credential for
a visitor to spend. The cost of a session lands on whoever opened it.

A product would invert that: hold one key server-side and mint a short-lived
token per session. Two things about those are easy to get wrong, and both cost
an hour if you meet them cold:

- They go in `access_token`, **not** `key`. An `AQ.…` token passed as `key`
  fails with *"Method doesn't allow unregistered callers"*, which reads like a
  revoked credential rather than a misnamed parameter.
- `newSessionExpireTime` defaults to **one minute** and the token is
  single-use. It is for handing to a browser that is about to connect, not for
  storing — so mint on the click, not on page load.

Confusingly, a current Google AI Studio API key *also* starts with `AQ.`. That
one is long-lived and goes in `key`. The prefix does not tell you which you
are holding.
