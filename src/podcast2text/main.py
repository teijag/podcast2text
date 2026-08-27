from __future__ import annotations

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware

from . import downloader, transcriber
from .db import get_connection, init_db
from .schemas import (
    Bookmark,
    BookmarkCreate,
    BookmarkUpdate,
    TranscribeRequest,
    TranscriptResponse,
    TranscriptSegment,
    Video,
    VideoSummary,
)

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
    downloader.check_yt_dlp_version()


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


@app.get("/videos", response_model=list[VideoSummary])
def list_videos() -> list[VideoSummary]:
    with get_connection() as conn:
        rows = conn.execute(
            """
            SELECT v.*, COUNT(b.id) AS bookmark_count
            FROM videos v
            LEFT JOIN bookmarks b ON b.video_id = v.id
            WHERE v.status = 'done'
            GROUP BY v.id
            ORDER BY v.created_at DESC
            """
        ).fetchall()
    return [
        VideoSummary(
            id=r["id"],
            url=r["url"],
            title=r["title"],
            channel=r["channel"],
            duration_seconds=r["duration_seconds"],
            status=r["status"],
            bookmark_count=r["bookmark_count"],
            last_viewed_at=r["last_viewed_at"],
            created_at=r["created_at"],
        )
        for r in rows
    ]


@app.post("/videos/{video_id}/viewed")
def mark_video_viewed(video_id: str) -> dict:
    with get_connection() as conn:
        cursor = conn.execute(
            "UPDATE videos SET last_viewed_at = datetime('now') WHERE id = ?", (video_id,)
        )
    if cursor.rowcount == 0:
        raise HTTPException(status_code=404, detail="Unknown video")
    return {"status": "ok"}


@app.get("/videos/{video_id}/transcript", response_model=TranscriptResponse)
def get_transcript(video_id: str) -> TranscriptResponse:
    result = _load_transcript(video_id)
    if result is None:
        raise HTTPException(status_code=404, detail="No transcript for this video")
    return result


@app.post("/bookmarks", response_model=Bookmark)
def create_bookmark(req: BookmarkCreate) -> Bookmark:
    with get_connection() as conn:
        video_exists = conn.execute(
            "SELECT 1 FROM videos WHERE id = ?", (req.video_id,)
        ).fetchone()
        if video_exists is None:
            raise HTTPException(status_code=404, detail="Unknown video")
        cursor = conn.execute(
            "INSERT INTO bookmarks (video_id, timestamp_seconds, comment) VALUES (?, ?, ?)",
            (req.video_id, req.timestamp_seconds, req.comment),
        )
        row = conn.execute(
            "SELECT * FROM bookmarks WHERE id = ?", (cursor.lastrowid,)
        ).fetchone()
    return _bookmark_from_row(row)


@app.get("/videos/{video_id}/bookmarks", response_model=list[Bookmark])
def list_bookmarks(video_id: str) -> list[Bookmark]:
    with get_connection() as conn:
        rows = conn.execute(
            "SELECT * FROM bookmarks WHERE video_id = ? ORDER BY timestamp_seconds",
            (video_id,),
        ).fetchall()
    return [_bookmark_from_row(r) for r in rows]


@app.patch("/bookmarks/{bookmark_id}", response_model=Bookmark)
def update_bookmark(bookmark_id: int, req: BookmarkUpdate) -> Bookmark:
    with get_connection() as conn:
        cursor = conn.execute(
            "UPDATE bookmarks SET comment = ? WHERE id = ?", (req.comment, bookmark_id)
        )
        if cursor.rowcount == 0:
            raise HTTPException(status_code=404, detail="Unknown bookmark")
        row = conn.execute("SELECT * FROM bookmarks WHERE id = ?", (bookmark_id,)).fetchone()
    return _bookmark_from_row(row)


@app.delete("/bookmarks/{bookmark_id}")
def delete_bookmark(bookmark_id: int) -> dict:
    with get_connection() as conn:
        cursor = conn.execute("DELETE FROM bookmarks WHERE id = ?", (bookmark_id,))
    if cursor.rowcount == 0:
        raise HTTPException(status_code=404, detail="Unknown bookmark")
    return {"status": "ok"}


def _bookmark_from_row(row) -> Bookmark:
    return Bookmark(
        id=row["id"],
        video_id=row["video_id"],
        timestamp_seconds=row["timestamp_seconds"],
        comment=row["comment"],
        created_at=row["created_at"],
    )


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
