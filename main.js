// Pot TTS plugin — Microsoft Edge Read Aloud.
//
// Speaks text through the same service Microsoft Edge's "Read Aloud" feature
// uses. Self-contained: no API key, no local server, no helper process.
//
// NOTE: text is sent to Microsoft's servers for synthesis. This is online TTS,
// not local synthesis.
//
// This file is eval'd as a CLASSIC SCRIPT by Pot (src/utils/invoke_plugin.js),
// so it must not use import/export, and must leave `tts` as the final
// expression (Pot appends the bare identifier `tts` to the source).

// ===========================================================================
// Edge Read Aloud protocol constants — UPDATED UPSTREAM, keep isolated.
// This block is the only part expected to change when Microsoft revises the
// service. See docs/DESIGN.md §4, §6.
// ===========================================================================
var EDGE_TRUSTED_CLIENT_TOKEN = "6A5AA1D4EAFF4E9FB37E23D68491D6F4";
var EDGE_CHROMIUM_VERSION = "143.0.3650.75";
var EDGE_WSS_BASE =
    "wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1";
var EDGE_OUTPUT_FORMAT = "audio-24khz-48kbitrate-mono-mp3";
var EDGE_MAX_CHUNK_BYTES = 4096;

// Inactivity timeout per chunk. Reset on every frame, so long utterances are
// fine as long as the service keeps streaming.
var EDGE_IDLE_TIMEOUT_MS = 30000;
// ===========================================================================


// --- User options ----------------------------------------------------------
// The controls themselves are declared in info.json's `needs`; Pot stores what
// the user picks as a {key: value} map and passes it in as options.config.
// Values are always strings, and a key is simply absent until the user touches
// that control. Two consequences of how Pot renders those controls are easy to
// get wrong, and both are load-bearing here — see docs/DESIGN.md §10:
//
//   * The FIRST option of every select must be this plugin's default. Pot
//     displays the first option's label whenever the stored value is missing,
//     so any other first entry would show a label the plugin does not act on.
//   * Option keys are opaque strings and must never be renamed after release:
//     a stored key that no longer exists renders as `undefined` in the UI.

// Used when the text's language has no entry below.
var TTS_FALLBACK_VOICE = "en-US-EmmaMultilingualNeural";

// Automatic voice per language code. These codes are exactly the values of
// info.json's `language` map: Pot passes that value through as `lang`, so every
// code Pot can send is covered. The fallback guards against a future code
// arriving before this table is updated.
var TTS_AUTO_VOICE = {
    "zh-CN": "zh-CN-XiaoxiaoNeural",
    "zh-TW": "zh-TW-HsiaoChenNeural",
    "en-US": "en-US-EmmaMultilingualNeural",
    "ja-JP": "ja-JP-KeitaNeural",
    "ko-KR": "ko-KR-HyunsuMultilingualNeural",
    "fr-FR": "fr-FR-VivienneMultilingualNeural",
    "es-ES": "es-ES-XimenaNeural",
    "ru-RU": "ru-RU-DmitryNeural",
    "de-DE": "de-DE-SeraphinaMultilingualNeural",
    "it-IT": "it-IT-GiuseppeMultilingualNeural",
    "tr-TR": "tr-TR-EmelNeural",
    "pt-PT": "pt-PT-DuarteNeural",
    "pt-BR": "pt-BR-ThalitaMultilingualNeural",
    "vi-VN": "vi-VN-HoaiMyNeural",
    "id-ID": "id-ID-ArdiNeural",
    "th-TH": "th-TH-NiwatNeural",
    "ms-MY": "ms-MY-OsmanNeural",
    "ar-SA": "ar-SA-HamedNeural",
    "hi-IN": "hi-IN-MadhurNeural",
    "mn-MN": "mn-MN-BataaNeural",
    "km-KH": "km-KH-PisethNeural",
    "nb-NO": "nb-NO-FinnNeural",
    "fa-IR": "fa-IR-DilaraNeural"
};

// Tier -> SSML prosody value. `normal` is deliberately absent: it maps to the
// neutral value below, as does any unrecognised key, so a stored value from an
// older build degrades to the default instead of breaking synthesis.
var TTS_RATE = { slower: "-20%", slow: "-40%", faster: "+25%", fast: "+50%" };
var TTS_PITCH = { slightLow: "-8Hz", low: "-16Hz", slightHigh: "+8Hz", high: "+16Hz" };
var TTS_VOLUME = { slightQuiet: "-25%", quiet: "-50%", slightLoud: "+25%", loud: "+50%" };

// The neutral prosody values also requested by the reference client.
var TTS_NEUTRAL_RATE = "+0%";
var TTS_NEUTRAL_PITCH = "+0Hz";
var TTS_NEUTRAL_VOLUME = "+0%";

// A custom voice must be one _edgeVoiceName can expand. Four of the 322 voices
// in the live catalog are Inuktitut names carrying a script subtag
// (iu-Latn-CA-SiqiniqNeural); the long-name form for those is not known, so
// they are refused here rather than sent as a guess. See docs/DESIGN.md §10.
var TTS_VOICE_SHAPE = /^[a-z]{2,}-[A-Z]{2,}-.+Neural$/;

function _ttsString(value) {
    if (value === undefined || value === null) {
        return "";
    }
    return String(value).trim();
}

function _ttsTier(table, value, neutral) {
    var key = _ttsString(value);
    return Object.prototype.hasOwnProperty.call(table, key) ? table[key] : neutral;
}

function _ttsCheckVoiceName(name) {
    if (TTS_VOICE_SHAPE.test(name)) {
        return name;
    }
    throw (
        "Edge Read Aloud: \"" + name + "\" is not a usable voice name.\n" +
        "Expected a short name such as en-US-EmmaMultilingualNeural " +
        "(<language>-<REGION>-<Name>Neural).\n" +
        "Clear the custom voice box to fall back to the voice selected above it."
    );
}

// Priority: the custom box beats the dropdown, which beats the per-language
// table. "auto" is the dropdown's "no explicit choice" sentinel.
function _ttsResolveVoice(config, lang) {
    var custom = _ttsString(config.voiceCustom);
    if (custom.length > 0) {
        return _ttsCheckVoiceName(custom);
    }

    var picked = _ttsString(config.voice);
    if (picked.length > 0 && picked !== "auto") {
        return picked;
    }

    var code = _ttsString(lang);
    return Object.prototype.hasOwnProperty.call(TTS_AUTO_VOICE, code)
        ? TTS_AUTO_VOICE[code]
        : TTS_FALLBACK_VOICE;
}


// --- Text preparation ------------------------------------------------------
// Mirrors the hardening edge-tts applies before embedding text in SSML.

// The service rejects a few control-character ranges outright. They are
// common in OCR'd PDFs, which is exactly the text Pot users paste.
function _edgeStripControlChars(value) {
    var out = "";
    for (var i = 0; i < value.length; i++) {
        var code = value.charCodeAt(i);
        if ((code >= 0 && code <= 8) || (code >= 11 && code <= 12) || (code >= 14 && code <= 31)) {
            out += " ";
        } else {
            out += value.charAt(i);
        }
    }
    return out;
}

// `&` must be replaced first, or the ampersands introduced by the later
// replacements would be escaped again.
function _edgeXmlEscape(value) {
    return value
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
}

// Split on UTF-8 byte length, preferring a newline or space, and never
// splitting mid-character or mid-XML-entity (`&amp;`).
function _edgeChunkText(escaped, maxBytes) {
    var encoder = new TextEncoder();
    var decoder = new TextDecoder("utf-8");
    var chunks = [];
    var bytes = encoder.encode(escaped);

    while (bytes.length > maxBytes) {
        var splitAt = -1;

        // Preferred: the last newline or space that still fits.
        for (var i = maxBytes - 1; i >= 0; i--) {
            if (bytes[i] === 0x0a || bytes[i] === 0x20) {
                splitAt = i;
                break;
            }
        }

        // Otherwise: step back to the start of a UTF-8 character.
        if (splitAt < 0) {
            splitAt = maxBytes;
            while (splitAt > 0 && (bytes[splitAt] & 0xc0) === 0x80) {
                splitAt--;
            }
        }

        // Never cut an XML entity in half: if the last `&` before the split
        // has no `;` after it, back the split up to that `&`.
        var amp = -1;
        for (var j = splitAt - 1; j >= 0; j--) {
            if (bytes[j] === 0x26) {
                amp = j;
                break;
            }
        }
        if (amp >= 0) {
            var terminated = false;
            for (var k = amp + 1; k < splitAt; k++) {
                if (bytes[k] === 0x3b) {
                    terminated = true;
                    break;
                }
            }
            if (!terminated) {
                splitAt = amp;
            }
        }

        // Guard against a stall if the split was pushed back to zero.
        if (splitAt <= 0) {
            splitAt = 1;
        }

        var head = decoder.decode(bytes.slice(0, splitAt)).trim();
        if (head.length > 0) {
            chunks.push(head);
        }
        bytes = bytes.slice(splitAt);
    }

    var tail = decoder.decode(bytes).trim();
    if (tail.length > 0) {
        chunks.push(tail);
    }
    return chunks;
}

// Short name to the long form the service expects:
//   en-US-EmmaMultilingualNeural
//     -> Microsoft Server Speech Text to Speech Voice (en-US, EmmaMultilingualNeural)
//   zh-CN-liaoning-XiaobeiNeural
//     -> Microsoft Server Speech Text to Speech Voice (zh-CN-liaoning, XiaobeiNeural)
function _edgeVoiceName(shortName) {
    var match = /^([a-z]{2,})-([A-Z]{2,})-(.+Neural)$/.exec(shortName);
    if (!match) {
        return shortName;
    }
    var lang = match[1];
    var region = match[2];
    var name = match[3];
    if (name.indexOf("-") !== -1) {
        region = region + "-" + name.slice(0, name.indexOf("-"));
        name = name.slice(name.indexOf("-") + 1);
    }
    return "Microsoft Server Speech Text to Speech Voice (" + lang + "-" + region + ", " + name + ")";
}

// `xml:lang` stays hardcoded to en-US even for other voices: the reference
// client does the same, and pronunciation follows the voice's own locale, not
// this attribute. Changing it is not known to do anything.
function _edgeBuildSsml(voiceShortName, escapedText, prosody) {
    return (
        "<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='en-US'>" +
        "<voice name='" + _edgeVoiceName(voiceShortName) + "'>" +
        "<prosody pitch='" + prosody.pitch + "' rate='" + prosody.rate +
        "' volume='" + prosody.volume + "'>" +
        escapedText +
        "</prosody>" +
        "</voice>" +
        "</speak>"
    );
}


// --- Auth ------------------------------------------------------------------
// The only credential is this derived token; there is no user account.

function _edgeRandomHex(byteCount, CryptoJS) {
    return CryptoJS.lib.WordArray.random(byteCount).toString(CryptoJS.enc.Hex).toUpperCase();
}

// SHA256 of (Windows FILETIME ticks rounded down to a 5-minute window, in
// 100-ns units) concatenated with the trusted client token.
//
// `ticks` reaches ~1.3e17, past Number.MAX_SAFE_INTEGER. That is safe here
// only because the reference implementation also works in IEEE-754 doubles,
// and toFixed(0) reproduces its formatting exactly. Verified against the
// reference across 206 timestamps — see docs/DESIGN.md §5.
function _edgeSecMsGec(CryptoJS) {
    var ticks = Date.now() / 1000 + 11644473600;
    ticks -= ticks % 300;
    ticks *= 1e7;
    return CryptoJS.SHA256(ticks.toFixed(0) + EDGE_TRUSTED_CLIENT_TOKEN)
        .toString(CryptoJS.enc.Hex)
        .toUpperCase();
}

function _pad2(value) {
    return value < 10 ? "0" + value : "" + value;
}

// e.g. "Sun Sep 14 2025 23:21:00 GMT+0000 (Coordinated Universal Time)"
function _edgeDateString() {
    var DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    var MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    var now = new Date();
    return (
        DAYS[now.getUTCDay()] + " " +
        MONTHS[now.getUTCMonth()] + " " +
        _pad2(now.getUTCDate()) + " " +
        now.getUTCFullYear() + " " +
        _pad2(now.getUTCHours()) + ":" +
        _pad2(now.getUTCMinutes()) + ":" +
        _pad2(now.getUTCSeconds()) +
        " GMT+0000 (Coordinated Universal Time)"
    );
}


// --- Wire framing ----------------------------------------------------------
// Text frames:   "Key:Value\r\n...\r\n\r\nPAYLOAD"
// Binary frames: [2-byte BE header length][header block][MP3 payload]
// The 2-byte length COVERS the header block including its trailing CRLFCRLF,
// so the payload starts at 2 + headerLength. Getting this wrong yields zero
// audio with no error at all.

function _edgeParseHeaders(bytes) {
    var text = new TextDecoder("utf-8").decode(bytes);
    var lines = text.split("\r\n");
    var headers = {};
    for (var i = 0; i < lines.length; i++) {
        var separator = lines[i].indexOf(":");
        if (separator > 0) {
            headers[lines[i].slice(0, separator)] = lines[i].slice(separator + 1);
        }
    }
    return headers;
}

function _edgeSpeakConfigMessage(boundaryEnabled) {
    return (
        "X-Timestamp:" + _edgeDateString() + "\r\n" +
        "Content-Type:application/json; charset=utf-8\r\n" +
        "Path:speech.config\r\n\r\n" +
        '{"context":{"synthesis":{"audio":{"metadataoptions":{' +
        '"sentenceBoundaryEnabled":"' + boundaryEnabled + '",' +
        '"wordBoundaryEnabled":"false"' +
        "}," +
        '"outputFormat":"' + EDGE_OUTPUT_FORMAT + '"' +
        "}}}}\r\n"
    );
}

function _edgeSsmlMessage(requestId, ssml) {
    // The trailing "Z" is not a mistake — it replicates an upstream quirk.
    return (
        "X-RequestId:" + requestId + "\r\n" +
        "Content-Type:application/ssml+xml\r\n" +
        "X-Timestamp:" + _edgeDateString() + "Z\r\n" +
        "Path:ssml\r\n\r\n" +
        ssml
    );
}

function _edgeConcat(parts, totalBytes) {
    var out = new Uint8Array(totalBytes);
    var offset = 0;
    for (var i = 0; i < parts.length; i++) {
        out.set(parts[i], offset);
        offset += parts[i].length;
    }
    return out;
}

// A handshake rejected by the service is indistinguishable from any other
// connection failure: the WebView reports an opaque error with no HTTP status
// and no headers, so the causes below cannot be told apart at runtime.
function _edgeHandshakeError() {
    return (
        "Could not connect to Microsoft Edge Read Aloud.\n" +
        "This plugin requires a Chromium-based WebView that identifies as " +
        "Microsoft Edge (Windows).\n" +
        "If you are on Windows, check your network, and make sure the system " +
        "clock is accurate — synthesis is rejected if it is off by more than " +
        "a few minutes."
    );
}


// --- Synthesis -------------------------------------------------------------

// One connection per chunk, matching the reference implementation. This keeps
// each request to a single clean request/response turn.
function _edgeSynthesizeChunk(escapedText, voiceShortName, prosody, CryptoJS) {
    return new Promise(function (resolve, reject) {
        var url =
            EDGE_WSS_BASE +
            "?TrustedClientToken=" + EDGE_TRUSTED_CLIENT_TOKEN +
            "&ConnectionId=" + _edgeRandomHex(16, CryptoJS) +
            "&Sec-MS-GEC=" + _edgeSecMsGec(CryptoJS) +
            "&Sec-MS-GEC-Version=1-" + EDGE_CHROMIUM_VERSION;

        var socket;
        try {
            socket = new WebSocket(url);
        } catch (err) {
            reject(new Error(_edgeHandshakeError()));
            return;
        }

        // Mandatory: the default is "blob", which cannot be parsed as bytes.
        socket.binaryType = "arraybuffer";

        var audioParts = [];
        var totalBytes = 0;
        var settled = false;
        var idleTimer = null;

        function armIdleTimer() {
            if (idleTimer !== null) {
                clearTimeout(idleTimer);
            }
            idleTimer = setTimeout(function () {
                finish(new Error(
                    "Timed out waiting for audio from Microsoft Edge Read Aloud."
                ));
            }, EDGE_IDLE_TIMEOUT_MS);
        }

        function finish(error) {
            if (settled) {
                return;
            }
            settled = true;
            if (idleTimer !== null) {
                clearTimeout(idleTimer);
            }
            try {
                socket.close();
            } catch (ignored) {
                // Already closing.
            }
            if (error) {
                reject(error);
            } else if (totalBytes === 0) {
                reject(new Error(
                    "Microsoft Edge Read Aloud returned no audio. " +
                    "The voice may be unavailable for this text."
                ));
            } else {
                resolve(_edgeConcat(audioParts, totalBytes));
            }
        }

        socket.onopen = function () {
            try {
                // Sentence boundaries are requested to match the reference
                // client; the metadata frames are ignored.
                socket.send(_edgeSpeakConfigMessage("true"));
                socket.send(_edgeSsmlMessage(
                    _edgeRandomHex(16, CryptoJS),
                    _edgeBuildSsml(voiceShortName, escapedText, prosody)
                ));
            } catch (err) {
                finish(new Error("Failed to send the synthesis request."));
                return;
            }
            armIdleTimer();
        };

        socket.onmessage = function (event) {
            armIdleTimer();

            if (typeof event.data === "string") {
                // Only turn.end matters; turn.start / response / audio.metadata
                // are informational.
                if (_edgeParseHeaders(new TextEncoder().encode(event.data)).Path === "turn.end") {
                    finish(null);
                }
                return;
            }

            var frame = new Uint8Array(event.data);
            if (frame.length < 2) {
                return;
            }
            var headerLength = (frame[0] << 8) | frame[1];
            if (headerLength > frame.length - 2) {
                return;
            }
            var headers = _edgeParseHeaders(frame.slice(2, 2 + headerLength));
            if (headers.Path !== "audio") {
                return;
            }
            // The payload is everything after the header block. Some frames
            // legitimately carry no payload and are skipped.
            var payload = frame.slice(2 + headerLength);
            if (payload.length > 0) {
                audioParts.push(payload);
                totalBytes += payload.length;
            }
        };

        socket.onerror = function () {
            finish(new Error(_edgeHandshakeError()));
        };

        socket.onclose = function (event) {
            // A clean close after turn.end is normal; anything else is a
            // failure. If audio already arrived we still use it.
            if (!settled) {
                if (totalBytes > 0) {
                    finish(null);
                } else {
                    finish(new Error(_edgeHandshakeError()));
                }
            }
        };
    });
}


// --- Pot entry point -------------------------------------------------------

async function tts(text, lang, options) {
    options = options || {};
    var utils = options.utils || {};
    var CryptoJS = utils.CryptoJS;
    // Absent until the user has touched a control, and absent entirely if this
    // instance was never configured — every read below tolerates that.
    var config = options.config || {};

    if (!CryptoJS) {
        throw "Edge Read Aloud: CryptoJS is unavailable, so the request cannot be signed.";
    }
    if (typeof WebSocket === "undefined") {
        throw "Edge Read Aloud: this Pot build does not expose WebSocket.";
    }
    if (!text || String(text).trim().length === 0) {
        throw "Edge Read Aloud: nothing to speak.";
    }

    var voice = _ttsResolveVoice(config, lang);
    var prosody = {
        rate: _ttsTier(TTS_RATE, config.rate, TTS_NEUTRAL_RATE),
        pitch: _ttsTier(TTS_PITCH, config.pitch, TTS_NEUTRAL_PITCH),
        volume: _ttsTier(TTS_VOLUME, config.volume, TTS_NEUTRAL_VOLUME)
    };

    var prepared = _edgeXmlEscape(_edgeStripControlChars(String(text)));
    var chunks = _edgeChunkText(prepared, EDGE_MAX_CHUNK_BYTES);

    var parts = [];
    var totalBytes = 0;
    for (var i = 0; i < chunks.length; i++) {
        var audio = await _edgeSynthesizeChunk(chunks[i], voice, prosody, CryptoJS);
        parts.push(audio);
        totalBytes += audio.length;
    }

    // Pot feeds this to WebAudio as `new Uint8Array(data)`, so it must be
    // bytes — never base64.
    return _edgeConcat(parts, totalBytes);
}
