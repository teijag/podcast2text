from __future__ import annotations

import os
import time
from pathlib import Path
from typing import Any

import yt_dlp

from .db import DATA_DIR

AUDIO_CACHE_DIR = DATA_DIR / "audio"

MAX_ATTEMPTS = 3
RETRY_DELAY_SECONDS = 5


def download_audio(url: str) -> tuple[Path, dict[str, Any]]:
    """Download the best available audio-only stream for a YouTube URL.

    Returns the path to the downloaded file and yt-dlp's info dict
    (used for the video id, title, channel, duration).

    Retries a few times: YouTube's serving CDN intermittently 403s a freshly
    resolved format URL (observed even immediately after a successful format
    resolution), and a short retry reliably clears it.
    """
    AUDIO_CACHE_DIR.mkdir(parents=True, exist_ok=True)

    ydl_opts = {
        "format": "bestaudio/best",
        "outtmpl": str(AUDIO_CACHE_DIR / "%(id)s.%(ext)s"),
        "noplaylist": True,
        "quiet": True,
        "no_warnings": True,
    }

    # Opt-in fallback: authenticate as a real signed-in session instead of an
    # anonymous one. Off by default since it prompts for OS keychain access.
    # Enable with e.g. YTDLP_COOKIES_BROWSER=chrome (or "safari", "firefox", ...).
    cookies_browser = os.environ.get("YTDLP_COOKIES_BROWSER")
    if cookies_browser:
        ydl_opts["cookiesfrombrowser"] = (cookies_browser,)

    last_error: Exception | None = None
    for attempt in range(1, MAX_ATTEMPTS + 1):
        try:
            with yt_dlp.YoutubeDL(ydl_opts) as ydl:
                info = ydl.extract_info(url, download=True)
                audio_path = Path(ydl.prepare_filename(info))
            return audio_path, info
        except yt_dlp.utils.DownloadError as exc:
            last_error = exc
            if attempt < MAX_ATTEMPTS:
                time.sleep(RETRY_DELAY_SECONDS)

    raise last_error
