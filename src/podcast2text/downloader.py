from __future__ import annotations

from pathlib import Path
from typing import Any

import yt_dlp

from .db import DATA_DIR

AUDIO_CACHE_DIR = DATA_DIR / "audio"


def download_audio(url: str) -> tuple[Path, dict[str, Any]]:
    """Download the best available audio-only stream for a YouTube URL.

    Returns the path to the downloaded file and yt-dlp's info dict
    (used for the video id, title, channel, duration).
    """
    AUDIO_CACHE_DIR.mkdir(parents=True, exist_ok=True)

    ydl_opts = {
        "format": "bestaudio/best",
        "outtmpl": str(AUDIO_CACHE_DIR / "%(id)s.%(ext)s"),
        "noplaylist": True,
        "quiet": True,
        "no_warnings": True,
        # The default (tv/web_safari) client combo is currently unreliable against
        # YouTube's SABR rollout (github.com/yt-dlp/yt-dlp/issues/12482). android_vr
        # consistently returns a plain audio-only stream without needing a PO token.
        "extractor_args": {"youtube": {"player_client": ["android_vr"]}},
    }

    with yt_dlp.YoutubeDL(ydl_opts) as ydl:
        info = ydl.extract_info(url, download=True)
        audio_path = Path(ydl.prepare_filename(info))

    return audio_path, info
