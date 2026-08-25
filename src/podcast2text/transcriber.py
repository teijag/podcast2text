from __future__ import annotations

import os
from typing import Optional

from faster_whisper import WhisperModel

from .schemas import TranscriptSegment

_model: Optional[WhisperModel] = None


def get_model() -> WhisperModel:
    global _model
    if _model is None:
        size = os.environ.get("WHISPER_MODEL_SIZE", "small")
        _model = WhisperModel(size, device="cpu", compute_type="int8")
    return _model


def transcribe(audio_path: str) -> list[TranscriptSegment]:
    model = get_model()
    segments, _info = model.transcribe(audio_path, vad_filter=True)
    return [
        TranscriptSegment(start=s.start, end=s.end, text=s.text.strip())
        for s in segments
    ]
