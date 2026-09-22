[English](./README.md) | [中文](./README.zh-CN.md)

# pot-app-tts-plugin-edge

A self-contained [Pot](https://github.com/pot-app/pot-desktop) text-to-speech
plugin that speaks text through the same service Microsoft Edge's **Read
Aloud** feature uses.

No Python, no local server, no Azure account, no API key, no helper process.
Drop in the `.potext` and it works.

> **Privacy:** text is sent to Microsoft's servers for synthesis. This is
> online TTS, not local synthesis.

## Status

Works. Voice, rate, pitch and volume are configurable, and a suitable voice is
chosen automatically for the translation's target language.

## Platform support

| Platform | Works |
|---|---|
| Windows (WebView2) | **Yes** |
| macOS (WKWebView) | No |
| Linux (WebKitGTK) | No |

This is a hard limitation, not a bug. The service requires a `User-Agent`
identifying as Microsoft Edge (major version ≥ 132), and a web page **cannot
set the `User-Agent` on a WebSocket handshake** — the plugin inherits whatever
the host WebView sends. Tauri uses WebView2 on Windows (which is Edge, so it
passes) but WebKit elsewhere (which does not). See `docs/DESIGN.md` §6.

## Install

Download `plugin.com.pot-app.edge_read_aloud_tts.potext` from the [latest
release](https://github.com/edwyj/pot-app-tts-plugin-edge/releases/latest), then
either drag it onto the Pot window, or import it from Pot's plugin settings.

After installing, enable it in **Settings → Service → Text to Speech**, then
use the speaker button on any translation result.

> **Not in the official plugin list.** The `pot-app` organisation — including
> `pot-desktop`, the plugin templates and `pot-app-plugin-list` — is archived on
> GitHub, and archived repositories cannot accept pull requests or new issues.
> This plugin is distributed from this repository's releases instead. Pot itself
> still works, and installing a plugin works the same way either way.

To build from source instead, see [Build](#build).

## Configuration

The controls appear in that same **Settings → Service → Text to Speech** panel.

| Control | Effect |
|---|---|
| 音色 — Voice | One of 25 curated voices. The default, 自动（按语言）, picks one from the translation's target language. |
| 自定义音色 — Custom voice | A voice short name such as `de-DE-KatjaNeural`. When filled in it **overrides** the dropdown. |
| 语速 / 音调 / 音量 | Rate / pitch / volume, five tiers each. |

The custom box is the escape hatch for the rest of the catalog: the service
offers **322 voices across 142 locales**, far more than a non-searchable
dropdown can hold. Names must look like
`<language>-<REGION>-<Name>Neural`. The four Inuktitut voices carrying a script
subtag (`iu-Latn-CA-SiqiniqNeural`) are rejected — the long name the service
expects for those is not known, so sending one would fail with no diagnostic.

**Option keys are permanent.** Pot stores the key rather than the label, and a
stored key that no longer exists renders as `undefined` in the UI. None of them
can be renamed after release. See `docs/DESIGN.md` §10.

## Build

```powershell
./build.ps1          # -> dist/<plugin-id>.potext
```

`build.ps1` mirrors `.github/workflows/build.yml`: both package the same three
files, so the two artifacts hold identical **contents**. They are not
byte-identical — the local build uses `Compress-Archive`, CI uses
`vimtor/action-zip`, and the two differ in compression and stored timestamps.
Compare extracted contents, not file hashes.

## Development notes

- `main.js` is **eval'd as a classic script** by Pot
  (`src/utils/invoke_plugin.js:35`). It must not use `import`/`export`, and
  must leave `tts` as the final expression — Pot appends the bare identifier
  `tts` to the source to obtain the completion value.
- The Edge protocol lives in one marked block at the top of `main.js`. That
  block is the only part expected to change when Microsoft updates the
  service.
- User options are declared in `info.json`'s `needs` and resolved in the
  "User options" block of `main.js`. Two rules there are load-bearing: the
  first option of every `select` must be the plugin's real default, and option
  keys must never be renamed. See `docs/DESIGN.md` §10.1.
- `docs/DESIGN.md` documents the plugin contract, the Pot runtime, the Edge
  Read Aloud protocol, and how each claim was verified.

## License

MIT. This is an independent JavaScript reimplementation of the Edge Read
Aloud *wire protocol*; no code from `rany2/edge-tts` (LGPLv3) was copied. See
`docs/DESIGN.md` §8.
