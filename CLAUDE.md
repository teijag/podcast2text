# CLAUDE.md

Guidance for Claude Code when working in this repository.

## Project

**podcast2text** — a tool that transcribes Spotify podcast audio or Youtube videos into text.

## Tech stack

- **Backend**: Python (FastAPI + SQLite), local-only — no cloud APIs, no API keys.
  - `yt-dlp` downloads audio for a YouTube URL.
  - `faster-whisper` transcribes it locally into timestamped segments.
  - Data lives in `data/podcast2text.db` (SQLite) and `data/audio/` (downloaded
    audio cache) — both git-ignored.
- **Frontend**: Chrome extension (Manifest V3). A content script injects a
  transcript sidebar into `youtube.com/watch` pages; a separate extension page
  is the video/bookmark library. Both talk to the local backend over HTTP.
- Planned: local EN↔ZH (Simplified) translation of transcripts, also
  fully local/free (e.g. NLLB-200 distilled + optional OpenCC pass).

### YouTube extraction: keep yt-dlp current

YouTube's anti-bot rollout ("SABR streaming",
github.com/yt-dlp/yt-dlp/issues/12482) is a live arms race between YouTube
and yt-dlp. **If real downloads start failing with `HTTP Error 403`** (while
`--simulate`/metadata extraction still works — a telltale sign), the fix that
actually worked for us was simply **upgrading to the latest yt-dlp**, not any
client-spoofing workaround. We spent a long debugging session trying
`player_client` overrides (`android_vr`, etc.), a local PO Token provider
([bgutil-ytdlp-pot-provider](https://github.com/Brainicism/bgutil-ytdlp-pot-provider)),
authenticated cookies, and `--force-ipv4` — none of it was the real fix.

**The catch**: yt-dlp releases after `2025.10.14` require **Python ≥3.10**.
`pip index versions yt-dlp` (no `--pre`) silently filters out anything
incompatible with your current Python and reports the newest *compatible*
version as "latest" — it will NOT tell you a newer release exists that your
Python can't run. Always cross-check against
`curl -s https://pypi.org/pypi/yt-dlp/json | python3 -c "import json,sys; print(json.load(sys.stdin)['info']['version'])"`
for the true latest release before concluding yt-dlp itself is up to date.

This machine only had the Python 3.9 that ships with Xcode Command Line
Tools, so we installed Homebrew + `python@3.12` and rebuilt `.venv` on it —
see Setup below. `bgutil-ytdlp-pot-provider` and the `YTDLP_COOKIES_BROWSER`
env var (see `downloader.py`) are no longer needed for the default path, but
`YTDLP_COOKIES_BROWSER` is still there as a harmless opt-in fallback if a
future YouTube change needs it again.

## Setup

Requires Python ≥3.10 (yt-dlp's requirement). On macOS, if you only have the
system Python (3.9, via Xcode Command Line Tools):

```bash
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
brew install python@3.12
```

Then:

```bash
python3.12 -m venv .venv   # or just python3 -m venv .venv if that's already ≥3.10
source .venv/bin/activate
pip install -e .
```

First run downloads the Whisper model (`small` by default, ~500MB) into the
local Hugging Face cache — this happens once and is cached across runs.

## How to run

```bash
source .venv/bin/activate
uvicorn podcast2text.main:app --reload --port 8765
```

The extension expects the backend at `http://localhost:8765`.

### Loading the extension

1. Chrome → `chrome://extensions` → enable **Developer mode** (top right).
2. **Load unpacked** → select the `extension/` folder.
3. With the backend running, open any `youtube.com/watch?v=...` page — a
   "Transcript" panel appears in the right column.

Click the extension's toolbar icon to open the **Library** page
(`extension/library.html`) — a grid of every transcribed video with a
bookmarks detail pane, searchable by title/channel/note text. Clicking a
video or bookmark opens YouTube in a new tab (deep-linked to that timestamp
for a bookmark).

The content script talks to the backend through a background service worker
(`extension/background.js`), not directly — content scripts on youtube.com
are subject to YouTube's page CSP, which a background service worker isn't,
so routing fetches through it avoids CSP/CORS issues that a direct
content-script fetch could hit.

## Conventions

- Keep functions small and focused; prefer clear names over comments.
- Follow existing formatting in the file you're editing. If a formatter is
  configured (black, ruff), run it before committing.
- Add or update a test when you change behavior.

## Important — do not commit

- **Secrets.** API keys live in `.env`, which is git-ignored. Never hard-code
  a key or commit `.env`. If you add a new key, document it in `.env.example`
  with a placeholder value.
- **Audio files.** Source audio is large and git-ignored by default. Don't
  add `.mp3`/`.wav`/etc. to commits unless it's a deliberately small sample.
- **Model weights.** Don't commit downloaded model files.

## Git workflow

- Branch: `main`. Remote: `origin` (github.com/teijag/podcast2text).
- Write short, present-tense commit messages ("Add SRT output", not "Added...").
- Always show me the diff and wait for approval before pushing.
