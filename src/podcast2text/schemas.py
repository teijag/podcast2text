from typing import Optional

from pydantic import BaseModel


class TranscribeRequest(BaseModel):
    url: str


class TranscriptSegment(BaseModel):
    start: float
    end: float
    text: str


class Video(BaseModel):
    id: str
    url: str
    title: Optional[str]
    channel: Optional[str]
    duration_seconds: Optional[float]
    status: str


class TranscriptResponse(BaseModel):
    video: Video
    segments: list[TranscriptSegment]


class BookmarkCreate(BaseModel):
    video_id: str
    timestamp_seconds: float
    comment: Optional[str] = None


class BookmarkUpdate(BaseModel):
    comment: Optional[str] = None


class VideoSummary(BaseModel):
    id: str
    url: str
    title: Optional[str]
    channel: Optional[str]
    duration_seconds: Optional[float]
    status: str
    bookmark_count: int
    last_viewed_at: Optional[str]
    created_at: str


class Bookmark(BaseModel):
    id: int
    video_id: str
    timestamp_seconds: float
    comment: Optional[str]
    created_at: str


class TranslateItem(BaseModel):
    start: float
    text: str


class TranslateRequest(BaseModel):
    video_id: str
    items: list[TranslateItem]


class TranslatedSegment(BaseModel):
    start: float
    translated_text: str


class TranslateResponse(BaseModel):
    items: list[TranslatedSegment]
