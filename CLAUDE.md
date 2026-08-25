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

### Known fragility: YouTube extraction

YouTube's anti-bot rollout ("SABR streaming") currently breaks `yt-dlp`'s
default client selection (github.com/yt-dlp/yt-dlp/issues/12482) — this is a
live arms race, not a bug in this repo. We force the `android_vr` player
client (`downloader.py`), which as of this writing reliably returns a plain
audio-only stream with no PO token needed. **If extraction starts failing
again**, that's most likely YouTube changing behavior, not this code — the
next fallback is a local PO Token provider:
[bgutil-ytdlp-pot-provider](https://github.com/Brainicism/bgutil-ytdlp-pot-provider)
(`pip install bgutil-ytdlp-pot-provider` + a small Node.js companion server).
We got that working during Phase 1 development (server cloned into
`data/pot-provider/`, git-ignored) but it isn't wired into the default path
since it's not currently needed. Note: the pip release (1.3.2) has an
upstream bug — it calls `logger.debug(msg, once=True)` but this yt-dlp
version's PO-token logger doesn't accept `once`, which silently breaks *all*
providers, not just the script-based one. Fix: strip `, once=True)` →
`)` from `getpot_bgutil_script.py` in the venv (see git history for the
one-liner that did this).

## Setup

```bash
python3 -m venv .venv
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

The extension (once built) expects the backend at `http://localhost:8765`.

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
