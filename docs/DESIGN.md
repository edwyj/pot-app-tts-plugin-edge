# Design — Pot Edge Read Aloud TTS plugin

Status: investigation complete, findings verified against live services and
against the app installed on this machine. MVP implemented.

Every claim below is marked with how it was established:

- **[SRC]** — read from upstream source, with file:line.
- **[EXP]** — verified by a minimal experiment run in `/_scratch_verify/`.
- **[INFER]** — reasoned, not directly verified. Flagged as a risk.

---

## 1. Verdict

A **pure `.potext` plugin is feasible on Windows**. No Python, no local HTTP
server, no Azure credentials, no API key, no helper process.

It works because Pot executes plugin code with a plain `eval()` **inside its
own WebView's global scope**, so plugin code gets a real browser `WebSocket`,
a real `CryptoJS`, and the browser's own `fetch` — and Pot's CSP does not block
`wss://`.

One **hard platform limitation** applies, and it is not something the plugin
can work around — see §6.2.

---

## 2. Pot TTS plugin interface

### 2.1 Contract

A TTS plugin is a directory containing `info.json`, `main.js`, and an icon.
Pot calls:

```js
tts(text, lang, options) -> audio bytes
```

- `text` — the text to synthesize.
- `lang` — `info.json`'s `language[targetLanguage]`; a mapping the plugin
  author chooses. [SRC] `src/window/Translate/components/TargetArea/index.jsx:349`
- `options.config` — per-instance user config, keyed by the `needs` entries in
  `info.json`. [SRC] `.../PluginConfig/index.jsx:52-76`
- `options.utils` — see §3.

### 2.2 What `tts()` must return

**A byte array — never a base64 string.** Pot feeds the return value straight
into WebAudio:

```js
// src/hooks/useVoice.jsx:14-18
audioContext.decodeAudioData(new Uint8Array(data).buffer, (buffer) => { ... })
```

[SRC] `src/hooks/useVoice.jsx:1-28`

Consequences:

- The value must be array-like of byte values (`number[]`, `Uint8Array`).
  A base64 string would be silently misinterpreted as byte values and produce
  garbage/silence — no error is raised.
- Any format `decodeAudioData` accepts works (MP3, WAV, OGG, M4A, FLAC). The
  service returns MP3, which is universally supported — so no transcoding.
- Playback is entirely in-process WebAudio. **No temp file, no media player**
  — `src-tauri` has no audio crate at all. [SRC] `src-tauri/Cargo.toml`
- There is no response unwrapping or status check: the value is passed through
  as-is. To report failure, **throw**.

### 2.3 How plugins are loaded

```js
// src/utils/invoke_plugin.js:9-35
let script = await readTextFile(entryFile);
...
return [eval(`${script} ${pluginType}`), utils];
```

[SRC] `src/utils/invoke_plugin.js:9-35`

Three consequences that shape `main.js`:

1. **It is `eval`'d as a classic script** — `import`/`export` are syntax
   errors. Only plain statements and function declarations.
2. The trailing `${pluginType}` makes the eval's completion value the `tts`
   identifier, so the file must **end in a way that leaves `tts` as the last
   expression**. A trailing `//` comment with no newline would swallow it
   (the appended ` tts` becomes part of the comment).
3. It is a *direct* `eval`, so plugin code is evaluated inside
   `invoke_plugin`'s scope. The enclosing bindings (`utils`, `http`,
   `CryptoJS`, …) are lexically visible even without `options.utils`.
   **Do not rely on this** — the production Vite bundle renames locals.
   Always use `options.utils`, whose property names survive minification.

### 2.4 Packaging

Zip `info.json` + `main.js` + the icon file, rename to `<id>.potext`.
The filename **must begin with `plugin`**: [SRC] `src-tauri/src/cmd.rs:141`
(install check) and `src-tauri/src/config.rs:160` (`get_plugin_list` actively
**deletes** any directory not starting with `plugin`).

---

## 3. Runtime capabilities available to plugin code

The `utils` object has exactly 10 keys. [SRC] `src/utils/invoke_plugin.js:23-34`

| key | value |
|---|---|
| `tauriFetch` | `@tauri-apps/api` `http.fetch` → Rust `reqwest` |
| `http` | the whole `@tauri-apps/api` http namespace (`Body`, `ResponseType`) |
| `readBinaryFile` / `readTextFile` | `@tauri-apps/api/fs` |
| `Database` | `tauri-plugin-sql` |
| **`CryptoJS`** | **crypto-js 4.2.0 default export** |
| `run` | `invoke("run_binary", …)` — arbitrary executables (we do **not** use this) |
| `cacheDir` / `pluginDir` | paths |
| `osType` | `"Windows_NT"` \| `"Darwin"` \| `"Linux"` |

Plus, because plugin code shares the WebView global scope, the **standard
browser `WebSocket`, `fetch`, `TextDecoder`, `DataView` are all in scope**.
[SRC] `invoke_plugin.js:35` + `window.rs:135`

### 3.1 WebSocket — reachable, and not blocked by CSP

`wss://` is usable. Pot's CSP is:

```json
"csp": "default-src * data: ; ... script-src * 'unsafe-eval';"
```

[SRC] `src-tauri/tauri.conf.json:106-109`

There is **no `connect-src` directive anywhere in the repo**, so it falls back
to `default-src *`, and `*` does match `ws:`/`wss:` in both Chromium and
WebKit. [SRC] `tauri.conf.json` (all platform overrides read) + [INFER] on the
`*`-matches-wss rule.

The windows also run with `--disable-web-security`.
[SRC] `src-tauri/src/window.rs:89`

### 3.2 `WebSocket` cannot set request headers — the central constraint

The browser `WebSocket` constructor takes `(url, protocols)`. The second
argument is **subprotocols only**; there is no `headers` option. The
Node/undici probe could set `User-Agent`/`Origin`/`Cookie`, but **plugin code
inside a WebView cannot**.

This matters because the service gates on the `User-Agent` (§6.1) and the
plugin therefore sends whatever the host WebView sends.

### 3.3 Why `tauriFetch` cannot substitute

Tauri v1's HTTP API is request/response only — it cannot express the
`speech.config` → `ssml` → interleaved `audio` / `turn.end` framing the
service requires. WebAudio needs the complete buffer anyway. So HTTP is not a
fallback transport.

---

## 4. Edge Read Aloud protocol

Reference: `edge-tts-reference/`, LGPLv3.

### 4.1 Endpoint and authentication

```
wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1
```

[SRC] `src/edge_tts/constants.py:3-7`

Query params: `TrustedClientToken=6A5AA1D4EAFF4E9FB37E23D68491D6F4`,
`ConnectionId=<32 hex, no dashes>`, `Sec-MS-GEC=<signed token>`,
`Sec-MS-GEC-Version=1-143.0.3650.75`.
[SRC] `src/edge_tts/drm.py:102-134`, `constants.py:11-13`, `communicate.py:466-468`

The only real authentication is the derived **`Sec-MS-GEC`** token. There are
no user credentials. It is a **plain SHA-256**, which is why `CryptoJS`
suffices — see §5.

### 4.2 Message flow

1. Connect the WebSocket.
2. Send a **`speech.config`** text frame declaring the output format:
   `audio-24khz-48kbitrate-mono-mp3`.
   [SRC] `communicate.py:431-440`
3. Send an **`ssml`** text frame (below).
   [SRC] `communicate.py:304-318`, `442-453`
4. Read frames until `Path:turn.end`:
   - TEXT `Path:audio.metadata` — word/sentence timings, **ignored** (we do
     not produce subtitles).
   - TEXT `Path:turn.end` — turn complete.
   - BINARY `Path:audio` — MP3 bytes.
   [SRC] `communicate.py:478-559`

Text frames are `header\r\nheader\r\n\r\npayload`. Binary frames are
`[2-byte big-endian headerLength][header block][payload]`, where `headerLength`
**covers the header block including its trailing `\r\n\r\n`** — so the payload
starts at `2 + headerLength`. Getting this off-by-prefix wrong yields zero
bytes of audio with no error. [SRC] `communicate.py:50-71`, `510-522`

### 4.3 SSML

```
<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='en-US'>
  <voice name='{voice}'><prosody pitch='+0Hz' rate='+0%' volume='+0%'>{escaped text}</prosody></voice>
</speak>
```

[SRC] `communicate.py:263-285`

The prosody values shown are the reference defaults. The plugin varies them
from user configuration — see §10.3 for the tier mapping and the citation for
the value formats. Every other part of the shape is fixed.

The voice must be given in **long form**:
`Microsoft Server Speech Text to Speech Voice (en-US, EmmaMultilingualNeural)`.
The transform from the short name is explicit in `data_classes.py:55-66`,
including the hyphen special case (e.g. `zh-CN-liaoning-XiaobeiNeural` →
region `zh-CN-liaoning`, name `XiaobeiNeural`).

Text handling before embedding [SRC] `communicate.py:74-99`, `349-352`:

- XML-escape `&`, `<`, `>`.
- Replace control chars `0-8`, `11-12`, `14-31` with a space — these are
  common in OCR'd PDFs and **cause a service-side error** if sent.
- Chunk to 4096 bytes, splitting on newline/space, never mid-UTF-8-character
  or mid-XML-entity.

---

## 5. `Sec-MS-GEC` — the only real cryptographic requirement

[SRC] `src/edge_tts/drm.py:102-134`

```
ticks  = unix_now + 11644473600        # Windows FILETIME epoch
ticks -= ticks % 300                   # round down to 5 minutes
ticks *= 1e7                           # 100-ns intervals
token  = SHA256(f"{ticks:.0f}" + TRUSTED_CLIENT_TOKEN).hexdigest().upper()
```

Two things were checked rather than assumed:

- **Float precision.** `ticks` reaches ~1.3e17, well past
  `Number.MAX_SAFE_INTEGER` (9.007e15), so a naive port could differ from
  Python. **[EXP]** Transcribed `drm.py` in Python and ported it to JS, then
  compared **206 timestamps** — including exact 300-second boundaries and
  large fractional values. All identical. `ticks.toFixed(0)` reproduces
  Python's `f"{ticks:.0f}"` exactly. Decimals are never involved.
- **Clock-skew recovery is NOT portable.** edge-tts handles a stale token by
  reading the `Date` response header off the 403 and re-syncing
  [SRC] `drm.py:75-100`, `communicate.py:590-597`. A WebSocket handshake
  rejection surfaces in a WebView as an **opaque `error` event with no status
  and no headers**. **[EXP]** Confirmed: a stale token, a missing `User-Agent`,
  and a garbage token are all indistinguishable (close code 1006, empty
  `TypeError`).

  So the plugin cannot self-correct a skewed clock. It computes the token from
  local time; if the machine clock is wrong by more than the 5-minute window,
  synthesis fails and the error message says so. This is a documented
  limitation, not an oversight.

---

## 6. Verified behaviours of the live service

Everything in this section was measured against
`speech.platform.bing.com`. Experiments are in `/_scratch_verify/`.

### 6.1 The `User-Agent` gate — the finding that decides the design

The service **requires a browser User-Agent**, and specifically one carrying an
**`Edg/` token with major version ≥ 132**.

| `User-Agent` | result |
|---|---|
| `Chrome/143 … Edg/143` | accepted |
| `Chrome/143` (no `Edg` token) | **rejected** |
| `Edg/143` alone | accepted |
| `Chrome/152 … Edg/152` (real WebView2 here) | accepted |
| `Edg/134`, `Edg/133`, `Edg/132` | accepted |
| `Edg/131`, `130`, `125`, `120`, `110`, `100` | **rejected** |
| macOS Safari 17 (WKWebView) | **rejected** |
| Linux WebKitGTK | **rejected** |

Notably it is a **hard version gate, not a consistency check**: `Edg/143` with
an old `Sec-MS-GEC-Version` of `1-131.0.0.0` still passes, and `Edg/131` with
a *matching* version still fails. Platform is irrelevant — `Chrome/143 Edg/143`
passes on a macOS UA too; it is the token that matters.

Everything else is optional: with **only** a `User-Agent`, and no `Origin`, no
`Cookie`, no `Pragma`, the handshake succeeds. So the `Origin:
chrome-extension://…` and `Cookie: muid=…` that edge-tts sends are **not
required**.

### 6.2 Consequence: Windows-only

Plugin code cannot set the handshake `User-Agent` (§3.2), so it inherits the
host WebView's UA:

- **Windows — works.** Tauri uses WebView2, whose UA is Edge's:
  `… Chrome/152.0.0.0 Safari/537.36 Edg/152.0.0.0`. This machine has WebView2
  `152.0.4191.66`, comfortably past the gate. Since WebView2 Evergreen
  auto-updates, any reasonably current install passes.
- **macOS (WKWebView) and Linux (WebKitGTK) — do not work.** Those send a
  Safari UA with no `Edg/` token, which the service rejects, and the plugin
  cannot override it. This is a **platform/platform limitation, not a bug**,
  and is not fixable within a pure `.potext` plugin.

A future fix would require a transport that can set headers — which means an
external helper, explicitly out of scope per AGENTS.md.

### 6.3 End-to-end confirmation

**[EXP]** The full reimplemented protocol (signing → handshake →
`speech.config` → SSML → binary framing) synthesizes the test sentence
correctly against the live service: **22,176 bytes** of MP3, valid MPEG-1
Layer III frame sync (`fff3`), clean `turn.end`, WebSocket close 1000.
22,176 bytes at 48 kbps ≈ 3.7 s, matching the sentence at normal rate.

---

## 7. Implementation notes

- **`binaryType` must be set to `"arraybuffer"`** immediately after
  constructing the WebSocket. The default is `"blob"`, which has no
  `readUInt16BE`. **[EXP]** — this was the first failure hit in the probe.
- No `Buffer` in a WebView; use `Uint8Array` / `DataView` / `TextDecoder`.
- Randomness: use `CryptoJS.lib.WordArray.random(16).toString()` for
  ConnectionId/RequestId rather than `crypto.randomUUID()`, avoiding any
  dependence on secure-context availability.
- Protocol constants and framing are isolated at the top of `main.js` under a
  marked section, per the "easy to update" constraint — the Chromium version
  and token are the parts that change upstream.
- **Timestamps are lenient.** `X-Timestamp` is not strictly validated: the
  probe sent a different format from Python's and was accepted. The
  implementation still emits Python's exact format.
- One WebSocket **per chunk**, processed **sequentially**. This matches
  edge-tts, which opens a fresh connection for each chunk
  [SRC] `communicate.py:461-473`, `585-597`, and avoids multi-turn state on a
  shared socket. The cost is that very long input is slow (a 5,930-byte text
  took ~75 s to synthesize ~6.6 min of audio) — inherent to the service, not a
  plugin defect. Pot's speaker button normally reads a translation result,
  which is short.

### 7.1 Verification performed

`/_scratch_verify/` contains the experiments. The plugin itself was run
through a harness that reproduces Pot's loader (`eval` inside a function
scope, with the trailing `tts` identifier appended) against the **live
service**, with `crypto-js` as the real CryptoJS implementation and a
`WebSocket` that injects the WebView's UA the way WebView2 does.

| Case | Result |
|---|---|
| AGENTS.md MVP sentence | 22,176 B valid MP3, ~3.7 s, ~1 s wall |
| `&` `<` `>` XML-hostile text | OK |
| OCR control chars (VT/FF/NUL) | OK |
| Multi-chunk (5,930 B → 2 connections) | OK |
| No-whitespace text (UTF-8 split path) | OK |
| Emoji / multibyte split safety | OK |
| Empty and whitespace-only input | throws a clear error |

The configuration surface added later was verified the same way, in
`test_config.js` — see §10.5.

One harness note worth keeping: evaling the plugin at **module top level**
fails with `Identifier 'tts' has already been declared`, because in sloppy
mode the plugin's `function tts` declaration collides with a caller-side
binding. Pot evals inside the `invoke_plugin` function body, so this never
occurs there. The harness mirrors that structure deliberately — otherwise it
reports a plugin bug that does not exist.

---

## 8. Licensing

`edge-tts` is **LGPLv3** (`LICENSE`), except `srt_composer.py` which is MIT.
This plugin is an **independent reimplementation in JavaScript**, not a port:
no Python source was copied or transliterated. What is reused is the
*wire protocol* — endpoint, message framing, SSML shape, and a SHA-256
construction — which is functional interface, not expressive code.
`drm.py`'s algorithm is reproduced in §5 from its documented description, and
the implementation here is original JS.

This is why no LGPL notice is carried. If substantial Python code is ever
translated into this plugin, that assessment must be revisited.

---

## 9. Known limitations

1. **Windows only** — see §6.2. Hard platform limit.
2. **No clock-skew recovery** — see §5. Fails opaquely if the system clock is
   off by more than ~5 minutes.
3. **No 403 diagnostics** — a rejected handshake gives no status code, so all
   handshake failures collapse into one generic error. The error text mentions
   the likely causes.
4. **The `Edg/ ≥132` gate is undocumented and may change.** It was measured,
   not specified. It is isolated in one place in `main.js` to make it easy to
   revise.
5. Text is sent to **Microsoft's servers**; this is not local synthesis.
6. **Four catalog voices are unreachable** — the Inuktitut names carrying a
   script subtag. See §10.4.

---

## 10. User-facing configuration

### 10.1 What Pot can render

`info.json`'s `needs` array is the only place a plugin declares configuration,
and exactly two control types render:

| `type` | Rendered as | Stored value |
|---|---|---|
| `input` | a text `Input` | the string typed |
| `select` | a NextUI `Dropdown` | **the option key** |

Anything else renders as nothing at all.
[SRC] `src/window/Config/pages/Service/PluginConfig/index.jsx:52-98`

Three properties of `select` shape this design:

1. **The stored value is the key, not the label.** `options` is a
   `{key: label}` object and `onAction` stores the key. [SRC] same file, `:84`
2. **A stored key that no longer exists renders `undefined`.** The trigger
   reads `x.options[pluginConfig[x.key]]` with no fallback, so renaming an
   option key in a later release breaks the display for everyone who had picked
   it. Option keys are a compatibility surface: **never rename one after
   release.** [SRC] `:79`
3. **Before the user touches a control its key is absent**, and the trigger
   then displays `Object.keys(x.options)[0]`'s label. So **the first option
   must be the plugin's real default** — otherwise the UI shows one thing while
   the plugin does another. [SRC] `:78`

There is also a JavaScript ordering trap: `Object.keys()` moves integer-like
keys to the front in ascending numeric order regardless of insertion order, so
a `{"-25": …, "0": …}` options object does not render as written. **[EXP]**
verified with `node` — `{"-25":…,"0":…,"15":…,"35":…}` yields
`["0","15","35","-25"]`. Every option key here is a word (`slow`, `normal`).

The dropdown is **not searchable**, and its menu is height-capped
(`max-h-[40vh] overflow-y-auto`). The live catalog holds **322 voices across
142 locales** [EXP] `_scratch_verify/voices.json`, so a complete list is not
usable in this control — hence a curated list plus a free-text escape hatch.

### 10.2 The five controls

| key | type | first option | notes |
|---|---|---|---|
| `voice` | `select` | `auto` | 25 curated voices: one per supported language, plus `en-US-Andrew` and `zh-CN-Yunxi` |
| `voiceCustom` | `input` | — | overrides `voice` when non-empty |
| `rate` | `select` | `normal` | |
| `pitch` | `select` | `normal` | |
| `volume` | `select` | `normal` | |

Labels are in Chinese because this deployment targets a Chinese-language Pot
install; only `display` strings inside `needs` are affected.

`info.json`'s `language` map has 25 keys but only 23 distinct values
(`mn_cy`/`mn_mo` both map to `mn-MN`; `nb_no`/`nn_no` both to `nb-NO`). Since
Pot passes the map's *value* through as `lang`, each of those 23 codes has an
entry in the automatic voice table.

### 10.3 Resolution rules

Voice, in priority order:

1. `voiceCustom`, when non-empty;
2. `voice`, when present and not `auto`;
3. the automatic table for `lang`;
4. otherwise `en-US-EmmaMultilingualNeural`.

Rate, pitch and volume map a tier to an SSML value. `normal` is deliberately
**absent** from the tables: it and any unrecognised key fall back to the
neutral value, so a stale stored key degrades quietly instead of failing.

| tier suffix | rate | pitch | volume |
|---|---|---|---|
| `slower` / `slightLow` / `slightQuiet` | `-20%` | `-8Hz` | `-25%` |
| `slow` / `low` / `quiet` | `-40%` | `-16Hz` | `-50%` |
| `faster` / `slightHigh` / `slightLoud` | `+25%` | `+8Hz` | `+25%` |
| `fast` / `high` / `loud` | `+50%` | `+16Hz` | `+50%` |

The value formats follow the reference client's CLI defaults — `+0%` for rate
and volume, `+0Hz` for pitch, each optionally signed.
[SRC] `util.py:108-110`

`xml:lang` stays hardcoded to `en-US` for every voice. The reference does the
same, and pronunciation follows the voice's own locale, not this attribute.

### 10.4 The custom voice box

A typed voice must be one `_edgeVoiceName` can expand, i.e. match
`^[a-z]{2,}-[A-Z]{2,}-.+Neural$`. Four of the 322 catalog voices are Inuktitut
names carrying a **script subtag** (`iu-Latn-CA-SiqiniqNeural`,
`iu-Cans-CA-…`). The long-name form for those is not known, so they are
**refused with a readable error** rather than sent as a guess that would fail
opaquely — the handshake offers no diagnostics (§9.3). 318 of 322 pass,
including the hyphenated-region form `zh-CN-liaoning-XiaobeiNeural` →
`Microsoft Server Speech Text to Speech Voice (zh-CN-liaoning, XiaobeiNeural)`.

The check runs before any socket is opened, so a typo costs no network round
trip. It cannot tell whether a well-formed name *exists*; the service is the
only authority on that, and an unknown-but-well-formed voice fails with the
same opaque handshake error as any other rejection.

### 10.5 Verification

**[EXP]** `_scratch_verify/test_config.js` drives the real `main.js` through
the same Pot-shaped loader described in §7.1, and captures the **SSML frame
actually sent on the wire** instead of inferring success from audio length.
12/12 passed:

| Case | Result |
|---|---|
| `config` absent, `{}`, and partial | neutral prosody, correct automatic voice |
| automatic voice for `en-US` / `zh-CN` / `ja-JP` | `Emma` / `Xiaoxiao` / `Keita`, as sent |
| dropdown overrides the automatic table | Andrew on `zh-CN` text, not 晓晓 |
| `voiceCustom` overrides the dropdown | 云希 won |
| all three tiers at once | `pitch='+16Hz' rate='-40%' volume='-50%'` accepted, MP3 returned |
| unrecognised tier key | fell back to neutral, no failure |
| unknown language code | fell back to `en-US` |
| invalid voice name | rejected locally, **no socket opened** |
| `iu-Latn-CA-SiqiniqNeural` | rejected locally, no socket opened |
| `zh-CN-liaoning-XiaobeiNeural` | expanded and synthesized |

That the tiers reach the *service* — not merely the frame — is shown by
duration: on identical text, `rate=-40%` encoded to **37,152 bytes** against
**22,176** at neutral, a ratio of 1.675.
