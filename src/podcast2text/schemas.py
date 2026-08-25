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
