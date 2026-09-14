# pot-app-tts-plugin-edge

A self-contained [Pot](https://github.com/pot-app/pot-desktop) text-to-speech
plugin that speaks text through the same service Microsoft Edge's **Read
Aloud** feature uses.

No Python, no local server, no Azure account, no API key, no helper process.
Drop in the `.potext` and it works.

> **Privacy:** text is sent to Microsoft's servers for synthesis. This is
> online TTS, not local synthesis.

## Status

MVP. Fixed to one English voice (`en-US-EmmaMultilingualNeural`) at normal
rate, pitch, and volume. Voice selection, rate/pitch/volume controls, and
automatic language→voice mapping are not implemented yet.

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

Build the package:

```powershell
./build.ps1
```

Then either drag `dist/plugin.com.pot-app.edge_read_aloud_tts.potext` onto the
Pot window, or import it from Pot's plugin settings.

After installing, enable it in **Settings → Service → Text to Speech**, then
use the speaker button on any translation result.

## Build

```powershell
./build.ps1          # -> dist/<plugin-id>.potext
```

`build.ps1` mirrors `.github/workflows/build.yml`, so local and CI artifacts
are identical.

## Development notes

- `main.js` is **eval'd as a classic script** by Pot
  (`src/utils/invoke_plugin.js:35`). It must not use `import`/`export`, and
  must leave `tts` as the final expression — Pot appends the bare identifier
  `tts` to the source to obtain the completion value.
- The Edge protocol lives in one marked block at the top of `main.js`. That
  block is the only part expected to change when Microsoft updates the
  service.
- `docs/DESIGN.md` documents the plugin contract, the Pot runtime, the Edge
  Read Aloud protocol, and how each claim was verified.

## License

MIT. This is an independent JavaScript reimplementation of the Edge Read
Aloud *wire protocol*; no code from `rany2/edge-tts` (LGPLv3) was copied. See
`docs/DESIGN.md` §8.
