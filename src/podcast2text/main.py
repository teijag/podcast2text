from __future__ import annotations

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware

from . import downloader, transcriber
from .db import get_connection, init_db
from .schemas import TranscribeRequest, TranscriptResponse, TranscriptSegment, Video

app = FastAPI(title="podcast2text")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.on_event("startup")
def on_startup() -> None:
    init_db()


@app.get("/health")
def health() -> dict:
    return {"status": "ok"}


@app.post("/transcribe", response_model=TranscriptResponse)
def transcribe_video(req: TranscribeRequest) -> TranscriptResponse:
    existing = _load_transcript(_video_id_from_url(req.url))
    if existing is not None:
        return existing

    try:
        audio_path, info = downloader.download_audio(req.url)
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"Could not download audio: {exc}")

    video_id = info["id"]

    with get_connection() as conn:
        conn.execute(
            """
            INSERT INTO videos (id, url, title, channel, duration_seconds, status)
            VALUES (?, ?, ?, ?, ?, 'transcribing')
            ON CONFLICT(id) DO UPDATE SET status = 'transcribing', error_message = NULL
            """,
            (
                video_id,
                req.url,
                info.get("title"),
                info.get("uploader"),
                info.get("duration"),
            ),
        )

    try:
        segments = transcriber.transcribe(str(audio_path))
    except Exception as exc:
        with get_connection() as conn:
            conn.execute(
                "UPDATE videos SET status = 'error', error_message = ? WHERE id = ?",
                (str(exc), video_id),
            )
        raise HTTPException(status_code=500, detail=f"Transcription failed: {exc}")

    with get_connection() as conn:
        conn.execute("DELETE FROM transcript_segments WHERE video_id = ?", (video_id,))
        conn.executemany(
            """
            INSERT INTO transcript_segments (video_id, start_seconds, end_seconds, text)
            VALUES (?, ?, ?, ?)
            """,
            [(video_id, s.start, s.end, s.text) for s in segments],
        )
        conn.execute("UPDATE videos SET status = 'done' WHERE id = ?", (video_id,))

    result = _load_transcript(video_id)
    assert result is not None
    return result


@app.get("/videos/{video_id}/transcript", response_model=TranscriptResponse)
def get_transcript(video_id: str) -> TranscriptResponse:
    result = _load_transcript(video_id)
    if result is None:
        raise HTTPException(status_code=404, detail="No transcript for this video")
    return result


def _video_id_from_url(url: str) -> str:
    """Best-effort extraction, used only to check the cache before downloading."""
    import urllib.parse as up

    parsed = up.urlparse(url)
    if parsed.hostname in ("youtu.be",):
        return parsed.path.lstrip("/")
    query = up.parse_qs(parsed.query)
    if "v" in query:
        return query["v"][0]
    return url


def _load_transcript(video_id: str) -> TranscriptResponse | None:
    with get_connection() as conn:
        video_row = conn.execute(
            "SELECT * FROM videos WHERE id = ? AND status = 'done'", (video_id,)
        ).fetchone()
        if video_row is None:
            return None
        segment_rows = conn.execute(
            "SELECT * FROM transcript_segments WHERE video_id = ? ORDER BY start_seconds",
            (video_id,),
        ).fetchall()

    return TranscriptResponse(
        video=Video(
            id=video_row["id"],
            url=video_row["url"],
            title=video_row["title"],
            channel=video_row["channel"],
            duration_seconds=video_row["duration_seconds"],
            status=video_row["status"],
        ),
        segments=[
            TranscriptSegment(start=r["start_seconds"], end=r["end_seconds"], text=r["text"])
            for r in segment_rows
        ],
    )
