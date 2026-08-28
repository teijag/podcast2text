from __future__ import annotations

import os
import re
import threading
from typing import Optional

import ctranslate2
import transformers
from huggingface_hub import snapshot_download

MODEL_NAME = os.environ.get("TRANSLATION_MODEL", "mijuanlo/nllb-200-distilled-600M-ct2-int8")

NLLB_LANG_CODES = {"en": "eng_Latn", "zh": "zho_Hans"}

_CJK_RE = re.compile(r"[一-鿿㐀-䶿]")

_translator: Optional[ctranslate2.Translator] = None
_tokenizer = None
_lock = threading.Lock()


def _load() -> tuple[ctranslate2.Translator, "transformers.PreTrainedTokenizerBase"]:
    global _translator, _tokenizer
    if _translator is None:
        with _lock:
            if _translator is None:
                model_dir = snapshot_download(MODEL_NAME)
                _translator = ctranslate2.Translator(model_dir, device="cpu", compute_type="int8")
                _tokenizer = transformers.AutoTokenizer.from_pretrained(model_dir)
    return _translator, _tokenizer


def detect_lang(text: str) -> str:
    """Cheap EN/ZH heuristic: any CJK character means Chinese."""
    return "zh" if _CJK_RE.search(text) else "en"


def translate_batch(texts: list[str]) -> list[tuple[str, str, str]]:
    """Auto-detects each text's language and translates EN<->ZH.

    Returns one (source_lang, target_lang, translated_text) tuple per input,
    in the same order as `texts`.
    """
    if not texts:
        return []
    translator, tokenizer = _load()

    results: list[Optional[tuple[str, str, str]]] = [None] * len(texts)
    by_lang: dict[str, list[int]] = {}
    for i, text in enumerate(texts):
        by_lang.setdefault(detect_lang(text), []).append(i)

    for src, indices in by_lang.items():
        tgt = "zh" if src == "en" else "en"
        tokenizer.src_lang = NLLB_LANG_CODES[src]
        source_tokens = [tokenizer.convert_ids_to_tokens(tokenizer.encode(texts[i])) for i in indices]
        target_prefix = [[NLLB_LANG_CODES[tgt]]] * len(indices)
        # beam_size=1 (greedy): with this int8-quantized checkpoint, beam
        # search (the library default) sometimes finds a higher-scoring
        # hypothesis that ends mid-sentence, truncating the translation.
        # Greedy decoding was reliably complete across testing.
        outputs = translator.translate_batch(source_tokens, target_prefix=target_prefix, beam_size=1)
        for idx, out in zip(indices, outputs):
            tokens = out.hypotheses[0][1:]
            ids = [i for i in tokenizer.convert_tokens_to_ids(tokens) if i != tokenizer.unk_token_id]
            translated = tokenizer.decode(ids).strip()
            results[idx] = (src, tgt, translated)

    return results  # type: ignore[return-value]
