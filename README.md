# YouTube Subtitle Translator (Firefox)

Translates a YouTube video's captions into your language when YouTube's own auto-translate isn't offered, fails or gives poor results. The translation runs on your own computer through **Ollama**, a free local AI runner. Nothing is sent to an outside service, and you need no account and pay no fees.

The add-on only adds one button to the player. It doesn't change playback, resume, autoplay or your YouTube caption settings.

This is an independent personal project. It is not affiliated with, endorsed by or sponsored by YouTube or Google. "YouTube" is a trademark of Google LLC.

## 1. Install Ollama (one time)

1. Download Ollama from **https://ollama.com/download** and install it.
2. In a terminal, download a model (the default is shown; see the table below to pick another):

   ```
   ollama pull gemma4:e4b
   ```

### Which model?

Subtitles need a model that answers fast enough to stay ahead of the video. Pick the biggest one your computer runs comfortably. Sizes are approximate download sizes.

| Your computer | Model | Size | Notes |
|---|---|---|---|
| Old or slow, 8 GB RAM | `gemma4:e2b` | ~4.6 GB | Fast. Rougher translations. |
| | `qwen3.5:2b` | ~2.7 GB | Smallest usable option. |
| Typical laptop, 8–16 GB RAM | `gemma4:e4b` **(default)** | ~6.6 GB | Good balance of quality and speed. |
| | `qwen3.5:4b` | ~3.3 GB | Lighter download. Good for Asian languages. |
| | `gemma3:4b` | ~3.3 GB | Previous generation. Still fine if you already have it. |
| 16 GB+ RAM or a GPU with 8 GB+ | `gemma4:12b` | ~7.7 GB | Noticeably better translations. |
| | `qwen3.5:9b` | ~6.6 GB | Very wide language coverage (200+ languages). |
| 32 GB RAM or a GPU with 16–24 GB | `gemma4:26b` | ~16 GB | Mixture-of-experts: big-model quality at about the speed of a 4B model. |
| Strong GPU (24 GB+) | `gemma4:31b`, `qwen3.5:27b` | ~17–20 GB | Best quality. Too slow without a strong GPU. |

Rules of thumb:
- **Gemma 4** is the best all-round choice, especially for European languages.
- **Qwen 3.5** covers more languages and is strong for Chinese, Japanese and Korean.
- If subtitles fall behind, go one size down.

Models that "think" before answering, such as Qwen 3.5, have that switched off automatically, because thinking would make the subtitles lag.

Translation-only models such as `translategemma` aren't supported. They need their own fixed prompt, so they can't follow the add-on's numbered, context-aware batches.

You can pick any installed model in the add-on's settings. If you use **LM Studio** instead, set the server address to `http://localhost:1234`.

## 2. Install the add-on (local install)

The add-on isn't signed by Mozilla or listed on addons.mozilla.org. You install it from this repository's source.

Get the code with `git clone https://github.com/SanttuA/ff-yt-translator.git`, or download the ZIP from GitHub and unpack it.

**Option A: temporary, any Firefox (no build needed)**

1. Open `about:debugging#/runtime/this-firefox`.
2. Click **Load Temporary Add-on…**.
3. Choose `extension/manifest.json` from the downloaded code.

The add-on stays installed until Firefox restarts. Repeat these steps after each restart.

**Option B: permanent, only in Firefox Developer Edition, Nightly or ESR**

Regular Firefox can't install unsigned add-ons permanently.

1. In `about:config`, set `xpinstall.signatures.required` to `false`.
2. Build the `.xpi` file. Use either of these:
   - With Node.js (see [Development](#development)): run `npm install` and then `npm run build`. The file is created at `dist/yt-translator.xpi`.
   - Without Node.js: zip the *contents* of the `extension/` folder, so that `manifest.json` is at the top level of the zip, and rename the zip to `yt-translator.xpi`.
3. In `about:addons`, click the gear icon, choose **Install Add-on From File…** and select the `.xpi`.

## 3. Use it

1. Open a YouTube video that has captions. Auto-generated captions count.
2. Click the **文A** button in the player's control bar. The translated lines appear over the video. A line still being translated shows "…".
3. Click the button again to turn it off. It is off for every new video until you click it.

The translation also shows in Firefox's **Picture-in-Picture** (pop-out) window. The window is small, so it shows only the translation, without the original line. In the pop-out window, Firefox's **CC** button turns subtitles on and off, and its settings set the text size.

Which captions get translated:
- If YouTube is already showing a caption track, the add-on translates that one.
- Otherwise it uses captions in the spoken language, preferring hand-made ones over auto-generated ones.

The toolbar icon opens the settings:
- target language (defaults to your browser's language)
- whether to show the original line
- subtitle size
- model and server address
- a **Test translation** button

Translations are saved, so a video you translated before shows them instantly. The add-on works on lines up to 10 minutes ahead of where you are watching.

## Troubleshooting

- **Red dot / "Can't reach the AI server".** Start Ollama (or run `ollama serve`), then press ↻ in the settings.
- **"Model … is not installed".** Run `ollama pull <model>`, or pick an installed model in the settings.
- **"The AI server refused the request (403)".** The add-on normally handles this by itself. If it keeps happening, allow extensions in Ollama:
  - Windows: `setx OLLAMA_ORIGINS "moz-extension://*"`
  - macOS: `launchctl setenv OLLAMA_ORIGINS "moz-extension://*"`
  - Linux: add `Environment="OLLAMA_ORIGINS=moz-extension://*"` with `sudo systemctl edit ollama`

  Then restart Ollama.
- **Subtitles lag behind.** The model is too slow for your computer. Pause briefly so it can get ahead, or switch to a smaller model.
- **"Could not get the caption file from YouTube".** Turn on YouTube's CC once (press `c`), then click the button again.
- **No 文A button.** The video has no captions, or its only captions are already in your target language.

## Privacy and security

- **Where your data goes:** captions and video titles are sent only to the AI server set in the add-on's settings. By default that is Ollama on your own computer. There is no telemetry and no outside service. If you point the server address at another machine, the captions go there instead.
- **What it stores:** your settings and the saved translations for up to 100 videos. These stay in Firefox's local add-on storage. "Clear saved translations" deletes them all.
- **Permissions and why each is needed:**
  - `www.youtube.com`: add the button and read caption files.
  - `localhost` / `127.0.0.1`: talk to Ollama or LM Studio.
  - `webRequest`: see which caption file the player loads.
  - `webRequestBlocking`: remove the `Origin` header from the add-on's own requests to the local AI server, so Ollama needs no extra setup. Requests made by websites are never changed.
  - `storage`: keep your settings and saved translations.
- **What it shows on screen:** captions come from whoever uploaded the video, and the model's answers are shown only as plain text. A video's captions could steer the model into writing odd subtitles, but they cannot run code or change anything else.
- **What it doesn't touch:** playback, seeking, resume, ads and autoplay. Embedded YouTube players on other sites aren't affected.

## Development

The add-on in `extension/` is plain JavaScript with no dependencies and no build step. The dev tools need Node.js 20.19+, 22.13+ or 24+:

```
npm install
npm run check   # ESLint + Mozilla's add-on linter (web-ext lint) + Jest tests
npm run build   # → dist/yt-translator.xpi
```

Pull requests to `main` run `npm run check` on GitHub Actions.

How the pieces fit together:
- `background.js` remembers YouTube's caption requests. They carry a token that YouTube requires. It also talks to the local AI server, and removes the browser's Origin header on those requests only, so Ollama accepts them without extra setup.
- `content.js` adds the button, picks and loads the caption track, and sends lines to the model in batches of 16. Each batch includes the 6 previous lines and the video title as context. It also draws the overlay, and copies the lines into a native subtitle track on the video so Firefox's Picture-in-Picture window can show them. That track is invisible on the page.
- `shared.js` holds the pure helpers that the tests cover: caption parsing, the prompt, and parsing the model's answer.
- `popup.*` is the settings page.

## License

[MIT](LICENSE)
