# CLAUDE.md

Guidance for Claude Code when working in this repository.

## Project

**podcast2text** — transcribes YouTube videos into a timestamped,
bookmarkable transcript, with local EN↔ZH translation. See
[README.md](README.md) for the full feature list, setup, and usage. Spotify
was considered early on and deliberately left out of scope — YouTube only.

## Tech stack

- **Backend**: Python (FastAPI + SQLite), local-only — no cloud APIs, no API keys.
  - `yt-dlp` downloads audio for a YouTube URL.
  - `faster-whisper` transcribes it locally into timestamped segments.
  - `translator.py` handles local EN↔ZH translation via NLLB-200 + CTranslate2.
  - Data lives in `data/podcast2text.db` (SQLite) and `data/audio/` (downloaded
    audio cache) — both git-ignored.
- **Frontend**: Chrome extension (Manifest V3). A content script injects a
  transcript sidebar into `youtube.com/watch` pages; a separate extension page
  is the video/bookmark library. Both talk to the local backend over HTTP.

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
See README's Troubleshooting section for the check/upgrade commands.

`bgutil-ytdlp-pot-provider` and the `YTDLP_COOKIES_BROWSER` env var (see
`downloader.py`) are no longer needed for the default path, but
`YTDLP_COOKIES_BROWSER` is still there as a harmless opt-in fallback if a
future YouTube change needs it again.

## Setup and running

See [README.md](README.md) for setup, running the backend, and loading the
extension — this file doesn't duplicate those steps.

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
