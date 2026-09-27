# 👻 Ghost Reviewer

**An AI critic that watches your screen while you build — and only speaks up when something's weak.**

Ghost Reviewer sits quietly in the background, glancing at your screen every so often. It doesn't narrate, doesn't cheerlead, and doesn't chime in on things that are fine. The moment it spots a genuinely weak point — a shaky claim, a vague number, a hand-wavy slide — it interrupts once, with a single sharp question, and it never asks the same thing twice.

No build step, no framework, no account. Plain HTML/CSS/JS on the front end, an optional zero-dependency Node proxy on the back end.

---

## Contents

- [How it works](#how-it-works)
- [Quick start](#quick-start)
- [Deploy to Vercel](#deploy-to-vercel)
- [Direct mode (no server)](#direct-mode-no-server)
- [Configuration](#configuration)
- [Choosing a model](#choosing-a-model)
- [Project structure](#project-structure)
- [Testing it](#testing-it)
- [Security notes](#security-notes)
- [License](#license)

## How it works

1. **Share a window or tab.** Ghost Reviewer captures it with `ImageCapture`, which keeps working even in a background tab.
2. **Every N seconds, it looks.** If the screen hasn't meaningfully changed since the last look, it skips the API call entirely.
3. **If it changed, it asks the model.** The frame is downscaled to a JPEG under 180 KB and sent along with your last 8 questions, so it never repeats itself.
4. **It only speaks when it's worth it.** A reply of `SILENT`, an empty reply, or a reworded repeat of an earlier question shows nothing.
5. **When it does interrupt:** a card barges onto the screen, the question is logged, a chime plays, and if the tab is hidden you also get a system notification and a flashing tab title.

| Piece | Role |
|---|---|
| `shared.js` | System prompt, request body, reply parsing, and near-duplicate detection. Shared by the browser and the server. |
| `app.js` | Screen capture, the timer loop, change detection, the interrupt UI, the floating window, notifications, and the chime. |
| `api/analyze.js` | Proxy to any OpenAI-compatible vision endpoint (NVIDIA by default). Keeps the API key server-side. |
| `api/health.js` | Lets the page detect whether the proxy is up and whether a key is configured. |
| `server.js` | Zero-dependency local static server + API router. Never serves dotfiles, so `.env` stays private. |

## Quick start

Requires **Node 18+**.

```bash
git clone https://github.com/<your-username>/ghost-reviewer.git
cd ghost-reviewer
cp .env.example .env      # then add your NVIDIA_API_KEY
node server.js            # http://localhost:3000
```

Open the page in **desktop Chrome or Edge**, click **Start watching**, and pick the window you're working in. Click **Float on top** to keep interruptions visible over your editor or slides while you work.

## Deploy to Vercel

```bash
npx vercel                       # first deploy
npx vercel env add NVIDIA_API_KEY
npx vercel --prod
```

Vercel serves the static files directly and runs `api/analyze.js` / `api/health.js` as serverless functions. The API key never reaches the browser, so the deployed link is safe to share.

## Direct mode (no server)

You can also open `index.html` directly with no server at all: switch **Settings → Model access** to **Direct** and paste a key in the browser.

⚠️ The key stays in that browser's local storage — only use this mode on your own machine, never on a shared or public one. Some providers (possibly including NVIDIA) block browser-origin calls via CORS; if a request fails in Direct mode, fall back to the proxy.

## Configuration

All configuration lives in `.env` (copy it from `.env.example`):

```bash
# Required
NVIDIA_API_KEY=nvapi-your-key-here

# Optional — any OpenAI-compatible vision endpoint/model works
LLM_ENDPOINT=https://integrate.api.nvidia.com/v1/chat/completions
LLM_MODEL=meta/muse-glimmer-30b
PORT=3000
```

Get a key at [build.nvidia.com](https://build.nvidia.com) — one key works across every hosted model there. Put only the raw `nvapi-…` value in `.env`; a `Bearer ` prefix is tolerated but not required, and it should never be committed (`.env` is already gitignored).

## Choosing a model

Set `LLM_MODEL` in `.env`. Informal results from testing (Sep 2026):

| Model | Behavior |
|---|---|
| `meta/muse-glimmer-30b` *(default)* | Stays silent on an empty slide; asks sharp, specific questions on a weak one. Slower — anywhere from 5 seconds to over a minute. |
| `meta/llama-3.2-11b-vision-instruct` | Fast (~1.5s) but noisy — interrupts even on empty slides. |
| `meta/llama-3.2-90b-vision-instruct` | Hung with no response in testing. |

Any other OpenAI-compatible vision endpoint should work by changing `LLM_ENDPOINT` and `LLM_MODEL` together.

## Project structure

```
ghost-reviewer/
├── api/
│   ├── analyze.js     # POST /api/analyze — proxies to the vision model
│   └── health.js      # GET  /api/health  — proxy/key status check
├── index.html          # App shell and settings panel
├── app.js              # Capture loop, UI, notifications
├── shared.js           # Prompt + request building, shared by client & server
├── server.js           # Local dev server (static files + API router)
├── styles.css
├── vercel.json          # Vercel function config
├── .env.example
└── package.json
```

## Testing it

1. Open a slide or document with an obviously weak claim — e.g. *"$500B market"* or *"everyone will use this."*
2. Click **Look now**.
3. The status bar should read *Looking…*, then show an interruption with a pointed question.
4. Point it at an empty or solid slide instead, and the status should settle back to *Silent*.

## Security notes

- `server.js` refuses to serve any dotfile path, so `.env` is never exposed over HTTP.
- In **Proxy** mode, the API key lives only on the server/serverless function — never sent to or stored in the browser.
- In **Direct** mode, the key is stored client-side; treat it like any credential typed into a browser you don't fully trust.

## License

[MIT](LICENSE) © 2026 The Ghost Reviewer Authors
