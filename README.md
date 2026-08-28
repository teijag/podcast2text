# podcast2text

A Chrome extension + local backend that gives YouTube videos a timestamped,
synced transcript — like Coursera's video transcripts — plus bookmarking,
a searchable library, and local EN↔ZH translation. Everything runs on your
machine: no cloud APIs, no API keys, no data leaving localhost.

## Features

- **Timestamped transcript sidebar** — injected into the YouTube watch page,
  auto-scrolls and highlights in sync with video playback.
- **Bookmarks with comments** — mark a moment in the transcript and attach a
  note to it, from the sidebar or the library.
- **Library** — a grid of every video you've transcribed, searchable by
  title/channel/note text, filterable by unwatched, sorted by most recently
  transcribed. Delete a video to remove its transcript, bookmarks, and
  translations.
- **Reading view** — a full article-style view of a video's transcript,
  grouped into paragraphs, with bookmarked sentences highlighted and their
  notes laid out in a Google-Docs-style right-hand column. Click a paragraph
  timestamp to jump to that point in the video.
- **Local EN↔ZH translation** — click Translate in the sidebar or the
  library to get an EN↔ZH translation appended under each line (sidebar) or
  each paragraph (library), powered by a local NLLB-200 model. Translations
  are cached, so translating once makes every other view of that video
  instant.

## How it works

- **Backend**: a local FastAPI server. [`yt-dlp`](https://github.com/yt-dlp/yt-dlp)
  downloads a video's audio, [`faster-whisper`](https://github.com/SYSTRAN/faster-whisper)
  (CTranslate2) transcribes it locally into timestamped segments, and an
  NLLB-200 model (also via CTranslate2) handles translation. Everything is
  stored in a local SQLite database.
- **Frontend**: a Manifest V3 Chrome extension. A content script injects the
  transcript sidebar into `youtube.com/watch` pages; a separate extension
  page is the library. Both talk to the local backend over HTTP — the
  content script routes through a background service worker rather than
  fetching directly, since YouTube's page CSP would otherwise block it.

No audio, transcripts, or translations ever leave your machine.

## Requirements

- Python ≥3.10
- Google Chrome (or another Chromium-based browser that supports Manifest V3
  extensions)
- ~1.2GB of disk space for model weights on first run (Whisper "small" is
  ~500MB, NLLB-200-distilled-600M is ~650MB) — downloaded once and cached
  locally, only if you use translation

## Setup

### 1. Backend

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -e .
```

If your system Python is older than 3.10 (e.g. macOS ships 3.9), install a
newer one first:

```bash
brew install python@3.12
python3.12 -m venv .venv
```

Start the server:

```bash
source .venv/bin/activate
uvicorn podcast2text.main:app --reload --port 8765
```

The extension expects the backend at `http://localhost:8765`. Leave this
running while you use the extension.

### 2. Extension

1. Open `chrome://extensions`, enable **Developer mode** (top right).
2. Click **Load unpacked** and select the `extension/` folder.
3. With the backend running, open any `youtube.com/watch?v=...` page — a
   transcript panel appears in the right column.


## Project structure

```
src/podcast2text/
  main.py          FastAPI app and routes
  db.py            SQLite schema and connection handling
  downloader.py    yt-dlp audio download
  transcriber.py   faster-whisper transcription
  translator.py    NLLB-200 + CTranslate2 translation
  schemas.py       Pydantic request/response models
extension/
  content.js/css   YouTube sidebar (content script)
  library.js/html/css   Library page and reading view
  background.js    Message router between content script and backend
data/              SQLite database + downloaded audio cache (git-ignored)
```

## Troubleshooting

**Downloads fail with `HTTP Error 403`, but metadata extraction still
works.** yt-dlp is out of date — YouTube's anti-bot measures change often
enough that this happens periodically. Upgrading yt-dlp is almost always
the actual fix, not cookies or client-spoofing tricks:

```bash
pip install --upgrade yt-dlp
```

One gotcha: on Python <3.10, `pip index versions yt-dlp` silently filters
out newer releases that aren't compatible with your Python version and
reports the newest *compatible* one as "latest" — so it can look up to
date when it isn't. Check the real latest release directly:

```bash
curl -s https://pypi.org/pypi/yt-dlp/json | python3 -c "import json,sys; print(json.load(sys.stdin)['info']['version'])"
```

If that's newer than what `pip show yt-dlp` reports and you're on an older
Python, upgrading Python first (`brew install python@3.12`, rebuild the
venv) is what actually fixes it.

## Notes

The NLLB-200 translation model is CC-BY-NC-4.0, non-commercial only.
