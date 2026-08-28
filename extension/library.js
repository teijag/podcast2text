const BACKEND = 'http://localhost:8765';

// CJK scripts don't use spaces between words/phrases, unlike Latin ones —
// used to decide whether a space belongs where two merged sentences meet.
function isCJK(ch) {
  return /[一-鿿。！？，、」』]/.test(ch);
}

const PLAY_ICON = `
  <svg class="lib-play-icon" width="22" height="22" viewBox="0 0 24 24" fill="rgba(255,255,255,0.5)">
    <polygon points="8 5 19 12 8 19"></polygon>
  </svg>
`;

const BOOKMARK_ICON = `
  <svg width="11" height="11" viewBox="0 0 24 24" fill="#F2B33D" stroke="none">
    <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"></path>
  </svg>
`;

const BOOKMARK_ICON_OUTLINE = `
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
    <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"></path>
  </svg>
`;

const BOOKMARK_ICON_FILLED = `
  <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" stroke="none">
    <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"></path>
  </svg>
`;

const TRASH_ICON = `
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <polyline points="3 6 5 6 21 6"></polyline>
    <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
  </svg>
`;

const THUMB_GRADIENTS = [
  'linear-gradient(135deg,#3a2f18,#171717)',
  'linear-gradient(135deg,#1a2a30,#141414)',
  'linear-gradient(135deg,#231a30,#141414)',
  'linear-gradient(135deg,#1a3024,#141414)',
  'linear-gradient(135deg,#301a1a,#141414)',
];

const PARAGRAPH_GAP_SECONDS = 1.5; // silence gap that starts a new paragraph
const SENTENCE_GAP_SECONDS = 0.4; // silence gap that starts a new sentence, absent punctuation
const MAX_SENTENCE_DURATION_SECONDS = 20; // beyond this, a "sentence" reads as an ungranular block
const MAX_SENTENCES_PER_PARAGRAPH = 5; // safety cap for continuous speech with no pauses
// Latin .!? need a following space to count (guards against false splits on
// decimals like "3.14"); CJK 。！？ don't — Chinese text has no spaces
// between sentences at all, so a following CJK character counts too.
const SENTENCE_BOUNDARY_RE = /[.!?。！？][)"'”」』]?(?=\s|$|[一-鿿])/g;

// Whisper's segment boundaries are cut by audio timing, not grammar — a "?"
// can trail into the START of the next segment rather than ending the
// current one, so checking each segment's own ending misses most sentences.
// Scan for sentence-ending punctuation across the combined text, and ALSO
// split on any real timing gap between segments — some content comes back
// from Whisper with little or no punctuation at all (observed: 2 punctuated
// segments out of 564 for one video), in which case punctuation alone would
// collapse nearly the whole transcript into a couple of giant blocks even
// though the audio has plenty of audible pauses to split on instead.
// Even combined, punctuation and gaps can both go missing for a long
// stretch (a long monologue with no punctuation and no pause) — any
// resulting "sentence" that's still too long to read as one line gets
// exploded back into its own raw segments rather than staying one block.
function groupIntoSentences(segments) {
  if (segments.length === 0) return [];

  let text = '';
  const ranges = []; // {seg, start, end (seconds), charStart, charEnd}
  for (const seg of segments) {
    if (text.length > 0) text += ' ';
    const charStart = text.length;
    const segText = seg.text.trim();
    text += segText;
    ranges.push({ seg, start: seg.start, end: seg.end, charStart, charEnd: charStart + segText.length });
  }

  const boundarySet = new Set();
  let match;
  while ((match = SENTENCE_BOUNDARY_RE.exec(text))) {
    boundarySet.add(match.index + match[0].length);
  }
  for (let i = 1; i < ranges.length; i++) {
    if (ranges[i].start - ranges[i - 1].end >= SENTENCE_GAP_SECONDS) {
      boundarySet.add(ranges[i - 1].charEnd);
    }
  }

  const boundaries = Array.from(boundarySet).sort((a, b) => a - b);
  if (boundaries.length === 0 || boundaries[boundaries.length - 1] < text.length) {
    boundaries.push(text.length);
  }

  const sentences = [];
  let charStart = 0;
  for (const charEnd of boundaries) {
    // Assign each raw segment to exactly one sentence, by where it STARTS —
    // not by any character overlap. A raw segment can straddle a sentence
    // boundary (it has its own punctuation mid-segment), and an overlap
    // test would then double-count it into both sentences, corrupting
    // bookmark matching (the same bookmark would match both).
    const covered = ranges.filter((r) => r.charStart >= charStart && r.charStart < charEnd);
    if (covered.length > 0) {
      const start = covered[0].start;
      const end = covered[covered.length - 1].end;
      if (covered.length > 1 && end - start > MAX_SENTENCE_DURATION_SECONDS) {
        for (const r of covered) {
          sentences.push({ start: r.seg.start, end: r.seg.end, text: r.seg.text.trim(), segmentStarts: [r.seg.start] });
        }
      } else {
        sentences.push({
          start,
          end,
          text: text.slice(charStart, charEnd).trim().replace(/\s+([.,!?。！？，])/g, '$1'),
          segmentStarts: covered.map((r) => r.start),
        });
      }
    }
    charStart = charEnd;
  }
  return sentences;
}

function groupIntoParagraphs(sentences) {
  const paragraphs = [];
  let current = [];
  for (const sent of sentences) {
    if (current.length > 0) {
      const prevEnd = current[current.length - 1].end;
      const gap = sent.start - prevEnd;
      if (gap >= PARAGRAPH_GAP_SECONDS || current.length >= MAX_SENTENCES_PER_PARAGRAPH) {
        paragraphs.push(current);
        current = [];
      }
    }
    current.push(sent);
  }
  if (current.length > 0) paragraphs.push(current);
  return paragraphs;
}

let videos = [];
let bookmarksByVideo = new Map(); // videoId -> bookmarks[]
let searchQuery = '';
let activeFilter = 'all'; // 'all' | 'unwatched'
let readingVideoId = null;
let readingVideo = null;
let readingSegments = [];
// Map<paragraph start seconds, translated text> for the currently rendered reading view.
let translationsByStart = new Map();
let translationsShown = false;

function formatTimestamp(seconds) {
  const total = Math.max(0, Math.floor(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = h > 0 ? String(m).padStart(2, '0') : String(m);
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

function formatDate(sqliteDatetime) {
  // SQLite's datetime('now') is UTC in "YYYY-MM-DD HH:MM:SS" form, which
  // isn't reliably parsed as UTC by `new Date()` unless made ISO-8601.
  const d = new Date(sqliteDatetime.replace(' ', 'T') + 'Z');
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text ?? '';
  return div.innerHTML;
}

function openVideoAt(videoId, seconds) {
  const t = seconds != null ? `&t=${Math.floor(seconds)}s` : '';
  chrome.tabs.create({ url: `https://www.youtube.com/watch?v=${videoId}${t}` });
}

async function loadLibrary() {
  const res = await fetch(`${BACKEND}/videos`);
  if (!res.ok) throw new Error(`Backend error ${res.status}`);
  videos = await res.json();

  const bookmarkLists = await Promise.all(
    videos.map((v) =>
      fetch(`${BACKEND}/videos/${encodeURIComponent(v.id)}/bookmarks`)
        .then((r) => (r.ok ? r.json() : []))
        .catch(() => [])
    )
  );
  bookmarksByVideo = new Map(videos.map((v, i) => [v.id, bookmarkLists[i]]));

  renderFilters();
  renderGrid();
}

function matchesSearch(video) {
  if (!searchQuery) return true;
  const haystack = [video.title, video.channel]
    .concat((bookmarksByVideo.get(video.id) || []).map((b) => b.comment))
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  return haystack.includes(searchQuery);
}

function matchesFilter(video) {
  return activeFilter === 'unwatched' ? !video.last_viewed_at : true;
}

function renderFilters() {
  const container = document.getElementById('lib-filters');
  const unwatchedCount = videos.filter((v) => !v.last_viewed_at).length;
  const chips = [
    { key: 'all', label: 'All', count: videos.length },
    { key: 'unwatched', label: 'Unwatched', count: unwatchedCount },
  ];
  container.innerHTML = chips
    .map(
      (c) => `
      <button class="lib-chip ${c.key === activeFilter ? 'lib-chip--active' : ''}" data-filter="${c.key}">
        ${c.label} &middot; ${c.count}
      </button>
    `
    )
    .join('');
  container.querySelectorAll('.lib-chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      activeFilter = chip.dataset.filter;
      renderFilters();
      renderGrid();
    });
  });
}

function renderGrid() {
  const grid = document.getElementById('lib-grid');
  const visible = videos.filter((v) => matchesFilter(v) && matchesSearch(v));

  if (visible.length === 0) {
    const message = searchQuery
      ? `No videos match "${escapeHtml(searchQuery)}".`
      : activeFilter === 'unwatched'
        ? 'Nothing unwatched — you\'re all caught up.'
        : 'No transcribed videos yet.';
    grid.innerHTML = `<div class="lib-empty">${message}</div>`;
    return;
  }

  grid.innerHTML = visible
    .map((v, i) => {
      const gradient = THUMB_GRADIENTS[i % THUMB_GRADIENTS.length];
      const bookmarkBadge =
        v.bookmark_count > 0
          ? `<div class="lib-card-bm-badge">${BOOKMARK_ICON}<span>${v.bookmark_count}</span></div>`
          : '';
      const durationBadge =
        v.duration_seconds != null
          ? `<div class="lib-card-duration">${formatTimestamp(v.duration_seconds)}</div>`
          : '';
      return `
        <div class="lib-card" data-video-id="${v.id}">
          <div class="lib-card-thumb" style="background:${gradient}">
            <img class="lib-card-thumb-img" src="https://img.youtube.com/vi/${v.id}/hqdefault.jpg" alt="" loading="lazy" onerror="this.remove()">
            ${PLAY_ICON}
            <button type="button" class="lib-card-delete" title="Remove from library">${TRASH_ICON}</button>
            ${bookmarkBadge}
            ${durationBadge}
          </div>
          <div class="lib-card-info">
            <div class="lib-card-title">${escapeHtml(v.title || v.id)}</div>
            <div class="lib-card-channel">${escapeHtml(v.channel || '')}</div>
            <div class="lib-card-meta">Transcribed ${formatDate(v.created_at)} &middot; ${
              v.bookmark_count > 0 ? `${v.bookmark_count} bookmark${v.bookmark_count === 1 ? '' : 's'}` : 'no bookmarks'
            }</div>
          </div>
        </div>
      `;
    })
    .join('');

  grid.querySelectorAll('.lib-card').forEach((card) => {
    card.addEventListener('click', () => openReading(card.dataset.videoId));
    card.querySelector('.lib-card-delete').addEventListener('click', (e) => {
      e.stopPropagation();
      onDeleteVideo(card.dataset.videoId);
    });
  });
}

async function onDeleteVideo(videoId) {
  const video = videos.find((v) => v.id === videoId);
  const title = video ? video.title || video.id : videoId;
  if (!confirm(`Remove "${title}" from your library? This deletes its transcript, bookmarks, and notes.`)) return;

  try {
    const res = await fetch(`${BACKEND}/videos/${encodeURIComponent(videoId)}`, { method: 'DELETE' });
    if (!res.ok) throw new Error(`Backend error ${res.status}`);
  } catch (_e) {
    alert('Could not remove this video. Is the local backend running?');
    return;
  }
  videos = videos.filter((v) => v.id !== videoId);
  bookmarksByVideo.delete(videoId);
  renderGrid();
}

function showPage(pageId) {
  document.getElementById('lib-page-grid').style.display = pageId === 'grid' ? '' : 'none';
  document.getElementById('lib-page-reading').style.display = pageId === 'reading' ? '' : 'none';
}

async function openReading(videoId) {
  readingVideoId = videoId;
  showPage('reading');

  const article = document.getElementById('rd-article');
  article.innerHTML = `<div class="lib-empty">Loading transcript&hellip;</div>`;

  let res;
  try {
    res = await fetch(`${BACKEND}/videos/${encodeURIComponent(videoId)}/transcript`);
  } catch (_e) {
    if (readingVideoId !== videoId) return; // navigated away while loading
    article.innerHTML = `<div class="lib-empty lib-error">Could not reach the local backend. Is it running?</div>`;
    return;
  }
  if (readingVideoId !== videoId) return; // navigated away while loading
  if (!res.ok) {
    article.innerHTML = `<div class="lib-empty lib-error">Could not load this transcript.</div>`;
    return;
  }
  const data = await res.json();
  readingVideo = data.video;
  readingSegments = data.segments;
  translationsByStart = new Map();
  translationsShown = false;
  renderReading();
}

function renderReading() {
  const video = readingVideo;
  const bookmarks = bookmarksByVideo.get(video.id) || [];
  // Bookmarks are stored against a segment start (legacy ones may reference
  // any segment within a sentence, e.g. from the YouTube sidebar), so match
  // on any of a sentence's constituent segment starts, not just its first.
  const bookmarkBySegStart = new Map(bookmarks.map((b) => [b.timestamp_seconds, b]));


  const sentences = groupIntoSentences(readingSegments);
  const paragraphs = groupIntoParagraphs(sentences);
  const allNotes = []; // collected in reading order, rendered in the right column
  // {start, text} per sentence, for translation requests. NLLB is trained
  // sentence-by-sentence and truncates when fed a whole multi-sentence
  // paragraph as one block, so we translate at sentence granularity and
  // join the results back into a paragraph for display below.
  const sentenceItems = [];

  const bodyHtml = paragraphs
    .map((group) => {
      let text = '';
      let translatedText = '';
      group.forEach((sent, i) => {
        sentenceItems.push({ start: sent.start, text: sent.text });
        const bm = sent.segmentStarts.map((s) => bookmarkBySegStart.get(s)).find(Boolean);
        if (bm) allNotes.push(bm);
        const words = escapeHtml(sent.text);
        const joiner = i > 0 && !(isCJK(group[i - 1].text.slice(-1)) || isCJK(sent.text.charAt(0))) ? ' ' : '';
        text += joiner;
        text += `
          <span class="rd-seg-wrap ${bm ? 'rd-seg-wrap--bookmarked' : ''}" data-start="${sent.start}" data-bookmark-id="${bm ? bm.id : ''}">
            <span class="${bm ? 'rd-highlight' : ''}">${words}</span>
            <button class="rd-bm-icon" type="button" title="${bm ? 'Edit note' : 'Add a note'}">${bm ? BOOKMARK_ICON_FILLED : BOOKMARK_ICON_OUTLINE}</button>
          </span>
        `;
        const sentTranslation = translationsByStart.get(sent.start);
        if (sentTranslation) translatedText += (translatedText ? ' ' : '') + sentTranslation;
      });
      const paraStart = group[0].start;
      const translationHtml = `
        <div class="rd-para-translation" data-start="${paraStart}" style="display:${translationsShown ? '' : 'none'}">
          ${escapeHtml(translatedText)}
        </div>
      `;
      return (
        `<p><button type="button" class="rd-para-time" data-start="${paraStart}">${formatTimestamp(paraStart)}</button>${text}</p>` +
        translationHtml
      );
    })
    .join('');

  const notesHtml = allNotes.length
    ? allNotes
        .map(
          (bm) => `
        <div class="rd-note" data-bookmark-id="${bm.id}">
          <span class="rd-note-time">${formatTimestamp(bm.timestamp_seconds)}</span>
          <div class="rd-note-text">${escapeHtml(bm.comment) || '<span class="rd-note-empty">No note yet</span>'}</div>
        </div>
      `
        )
        .join('')
    : `<div class="rd-notes-empty">Bookmark a sentence to see your notes here.</div>`;

  const byline = [video.channel, video.duration_seconds != null ? formatTimestamp(video.duration_seconds) : null, `${bookmarks.length} bookmark${bookmarks.length === 1 ? '' : 's'}`]
    .filter(Boolean)
    .join(' &middot; ');

  document.getElementById('rd-article').innerHTML = `
    <div class="rd-main">
      <div class="rd-title">${escapeHtml(video.title || video.id)}</div>
      <div class="rd-byline-row">
        <div class="rd-byline">${byline}</div>
        <div class="rd-byline-actions">
          <button type="button" class="rd-translate-btn" id="rd-translate-btn">Translate</button>
          <div class="rd-open-video" id="rd-open-video">
            Open video
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#F2B33D" stroke-width="2" stroke-linecap="round"><line x1="7" y1="17" x2="17" y2="7"></line><polyline points="7 7 17 7 17 17"></polyline></svg>
          </div>
        </div>
      </div>
      <div class="rd-divider"></div>
      <div class="rd-body">${bodyHtml}</div>
    </div>
    <div class="rd-notes-col">${notesHtml}</div>
  `;

  document.getElementById('rd-open-video').onclick = () => openVideoAt(video.id, null);
  const translateBtn = document.getElementById('rd-translate-btn');
  translateBtn.textContent = translationsShown ? 'Hide translation' : 'Translate';
  translateBtn.onclick = () => onTranslateClick(translateBtn, sentenceItems);

  document.getElementById('rd-article').querySelectorAll('.rd-notes-col .rd-note').forEach((el) => {
    el.addEventListener('click', () => {
      const segWrap = document.querySelector(`.rd-seg-wrap[data-bookmark-id="${el.dataset.bookmarkId}"]`);
      if (segWrap) openNotePopover(segWrap);
    });
  });

  positionNotes();
}

async function onTranslateClick(btn, sentenceItems) {
  if (translationsShown) {
    translationsShown = false;
    renderReading();
    return;
  }
  if (translationsByStart.size > 0) {
    translationsShown = true;
    renderReading();
    return;
  }

  btn.disabled = true;
  btn.textContent = 'Translating…';
  const videoId = readingVideoId;
  try {
    const res = await fetch(`${BACKEND}/translate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ video_id: videoId, items: sentenceItems }),
    });
    if (readingVideoId !== videoId || !res.ok) {
      btn.disabled = false;
      btn.textContent = 'Translate';
      return;
    }
    const data = await res.json();
    for (const item of data.items) translationsByStart.set(item.start, item.translated_text);
    translationsShown = true;
    btn.disabled = false;
    renderReading();
  } catch (_e) {
    btn.disabled = false;
    btn.textContent = 'Translate';
  }
}

// Aligns each note in the right column with the vertical position of the
// sentence it belongs to, Google-Docs-comment style, while keeping a
// minimum gap between consecutive notes so they never overlap.
function positionNotes() {
  const article = document.getElementById('rd-article');
  const main = article.querySelector('.rd-main');
  const notesCol = article.querySelector('.rd-notes-col');
  const noteEls = Array.from(notesCol.querySelectorAll('.rd-note'));
  if (noteEls.length === 0) return;

  const mainTop = main.getBoundingClientRect().top;
  let prevBottom = 0;
  noteEls.forEach((noteEl) => {
    const segWrap = document.querySelector(`.rd-seg-wrap[data-bookmark-id="${noteEl.dataset.bookmarkId}"]`);
    if (!segWrap) return;
    const segTop = segWrap.getBoundingClientRect().top - mainTop;
    const top = Math.max(segTop, prevBottom + 10);
    noteEl.style.top = `${top}px`;
    prevBottom = top + noteEl.offsetHeight;
  });
}

function closeAnyPopover() {
  const hadOne = document.querySelector('.rd-popover');
  document.querySelectorAll('.rd-popover').forEach((el) => el.remove());
  if (hadOne) positionNotes(); // removing it shifts the paragraphs below back up
}

function openNotePopover(segWrap) {
  closeAnyPopover();
  const bookmarkId = segWrap.dataset.bookmarkId || null;
  const existing = bookmarkId
    ? (bookmarksByVideo.get(readingVideoId) || []).find((b) => String(b.id) === bookmarkId)
    : null;

  const popover = document.createElement('div');
  popover.className = 'rd-popover';
  popover.innerHTML = `
    <textarea class="rd-popover-input" placeholder="What's worth remembering here?">${escapeHtml(existing?.comment || '')}</textarea>
    <div class="rd-popover-actions">
      ${bookmarkId ? '<button type="button" class="rd-popover-delete">Delete</button>' : ''}
      <button type="button" class="rd-popover-cancel">Cancel</button>
      <button type="button" class="rd-popover-save">Save</button>
    </div>
  `;
  segWrap.closest('p').after(popover);
  positionNotes(); // inserting it pushes the paragraphs below down

  const textarea = popover.querySelector('.rd-popover-input');
  textarea.focus();

  popover.querySelector('.rd-popover-cancel').addEventListener('click', closeAnyPopover);
  popover
    .querySelector('.rd-popover-save')
    .addEventListener('click', () => saveNote(segWrap, textarea.value.trim(), bookmarkId));
  const deleteBtn = popover.querySelector('.rd-popover-delete');
  if (deleteBtn) deleteBtn.addEventListener('click', () => deleteNote(bookmarkId));
}

async function saveNote(segWrap, comment, bookmarkId) {
  const videoId = readingVideoId;
  try {
    const res = bookmarkId
      ? await fetch(`${BACKEND}/bookmarks/${bookmarkId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ comment: comment || null }),
        })
      : await fetch(`${BACKEND}/bookmarks`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            video_id: videoId,
            timestamp_seconds: Number(segWrap.dataset.start),
            comment: comment || null,
          }),
        });
    if (!res.ok) throw new Error(`Backend error ${res.status}`);
  } catch (_e) {
    // Leave the popover open so the typed comment isn't lost on failure.
    alert('Could not save this note. Is the local backend running?');
    return;
  }
  closeAnyPopover();
  await refreshBookmarks(videoId);
}

async function deleteNote(bookmarkId) {
  const videoId = readingVideoId;
  try {
    const res = await fetch(`${BACKEND}/bookmarks/${bookmarkId}`, { method: 'DELETE' });
    if (!res.ok) throw new Error(`Backend error ${res.status}`);
  } catch (_e) {
    alert('Could not delete this note. Is the local backend running?');
    return;
  }
  closeAnyPopover();
  await refreshBookmarks(videoId);
}

async function refreshBookmarks(videoId) {
  let bookmarks;
  try {
    const res = await fetch(`${BACKEND}/videos/${encodeURIComponent(videoId)}/bookmarks`);
    bookmarks = res.ok ? await res.json() : bookmarksByVideo.get(videoId) || [];
  } catch (_e) {
    return; // keep whatever's already shown rather than clobbering it
  }
  bookmarksByVideo.set(videoId, bookmarks);

  const video = videos.find((v) => v.id === videoId);
  if (video) video.bookmark_count = bookmarks.length;

  if (readingVideoId === videoId) renderReading();
}

document.getElementById('rd-article').addEventListener('click', (e) => {
  const paraTime = e.target.closest('.rd-para-time');
  if (paraTime) {
    openVideoAt(readingVideo.id, Number(paraTime.dataset.start));
    return;
  }
  const icon = e.target.closest('.rd-bm-icon');
  if (icon) {
    openNotePopover(icon.closest('.rd-seg-wrap'));
  }
});

document.getElementById('rd-back').addEventListener('click', () => {
  readingVideoId = null;
  showPage('grid');
});

document.getElementById('lib-search-input').addEventListener('input', (e) => {
  searchQuery = e.target.value.trim().toLowerCase();
  renderGrid();
});

loadLibrary().catch((err) => {
  document.getElementById('lib-grid').innerHTML = `<div class="lib-empty lib-error">Could not reach the local backend. Is it running?<br>(${escapeHtml(err.message)})</div>`;
});
