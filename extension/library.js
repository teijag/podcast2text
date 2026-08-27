const BACKEND = 'http://localhost:8765';

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

const THUMB_GRADIENTS = [
  'linear-gradient(135deg,#3a2f18,#171717)',
  'linear-gradient(135deg,#1a2a30,#141414)',
  'linear-gradient(135deg,#231a30,#141414)',
  'linear-gradient(135deg,#1a3024,#141414)',
  'linear-gradient(135deg,#301a1a,#141414)',
];

const PARAGRAPH_GAP_SECONDS = 1.5; // silence gap that starts a new paragraph
const MAX_SENTENCES_PER_PARAGRAPH = 5; // safety cap for continuous speech with no pauses
const SENTENCE_BOUNDARY_RE = /[.!?][)"'”]?(?=\s|$)/g;

// Whisper's segment boundaries are cut by audio timing, not grammar — a "?"
// can trail into the START of the next segment rather than ending the
// current one, so checking each segment's own ending misses most sentences.
// Scan for sentence-ending punctuation across the combined text instead,
// then map each resulting sentence back to the segments (and timestamps)
// it overlaps.
function groupIntoSentences(segments) {
  if (segments.length === 0) return [];

  let text = '';
  const ranges = []; // {start, end (seconds), charStart, charEnd}
  for (const seg of segments) {
    if (text.length > 0) text += ' ';
    const charStart = text.length;
    const segText = seg.text.trim();
    text += segText;
    ranges.push({ start: seg.start, end: seg.end, charStart, charEnd: charStart + segText.length });
  }

  const boundaries = [];
  let match;
  while ((match = SENTENCE_BOUNDARY_RE.exec(text))) {
    boundaries.push(match.index + match[0].length);
  }
  if (boundaries.length === 0 || boundaries[boundaries.length - 1] < text.length) {
    boundaries.push(text.length);
  }

  const sentences = [];
  let charStart = 0;
  for (const charEnd of boundaries) {
    const covered = ranges.filter((r) => r.charStart < charEnd && r.charEnd > charStart);
    if (covered.length > 0) {
      sentences.push({
        start: covered[0].start,
        end: covered[covered.length - 1].end,
        text: text.slice(charStart, charEnd).trim().replace(/\s+([.,!?])/g, '$1'),
        segmentStarts: covered.map((r) => r.start),
      });
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
  });
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

  const res = await fetch(`${BACKEND}/videos/${encodeURIComponent(videoId)}/transcript`);
  if (readingVideoId !== videoId) return; // navigated away while loading
  if (!res.ok) {
    article.innerHTML = `<div class="lib-empty lib-error">Could not load this transcript.</div>`;
    return;
  }
  const data = await res.json();
  readingVideo = data.video;
  readingSegments = data.segments;
  renderReading();
}

function renderReading() {
  const video = readingVideo;
  const bookmarks = bookmarksByVideo.get(video.id) || [];
  // Bookmarks are stored against a segment start (legacy ones may reference
  // any segment within a sentence, e.g. from the YouTube sidebar), so match
  // on any of a sentence's constituent segment starts, not just its first.
  const bookmarkBySegStart = new Map(bookmarks.map((b) => [b.timestamp_seconds, b]));

  document.getElementById('rd-open-video').onclick = () => openVideoAt(video.id, null);

  const sentences = groupIntoSentences(readingSegments);
  const paragraphs = groupIntoParagraphs(sentences);

  const bodyHtml = paragraphs
    .map((group) => {
      const notes = [];
      const text = group
        .map((sent) => {
          const bm = sent.segmentStarts.map((s) => bookmarkBySegStart.get(s)).find(Boolean);
          if (bm) notes.push(bm);
          const words = escapeHtml(sent.text);
          return `
            <span class="rd-seg-wrap ${bm ? 'rd-seg-wrap--bookmarked' : ''}" data-start="${sent.start}" data-bookmark-id="${bm ? bm.id : ''}">
              <span class="${bm ? 'rd-highlight' : ''}">${words}</span>
              <button class="rd-bm-icon" type="button" title="${bm ? 'Edit note' : 'Add a note'}">${bm ? BOOKMARK_ICON_FILLED : BOOKMARK_ICON_OUTLINE}</button>
            </span>
          `;
        })
        .join(' ');
      const noteHtml = notes
        .map(
          (bm) =>
            `<div class="rd-note">${escapeHtml(bm.comment) || '<span class="rd-note-empty">No note yet</span>'}</div>`
        )
        .join('');
      return `<p><span class="rd-para-time">${formatTimestamp(group[0].start)}</span>${text}</p>${noteHtml}`;
    })
    .join('');

  const byline = [video.channel, video.duration_seconds != null ? formatTimestamp(video.duration_seconds) : null, `${bookmarks.length} bookmark${bookmarks.length === 1 ? '' : 's'}`]
    .filter(Boolean)
    .join(' &middot; ');

  document.getElementById('rd-article').innerHTML = `
    <div class="rd-title">${escapeHtml(video.title || video.id)}</div>
    <div class="rd-byline">${byline}</div>
    <div class="rd-divider"></div>
    <div class="rd-body">${bodyHtml}</div>
  `;
}

function closeAnyPopover() {
  document.querySelectorAll('.rd-popover').forEach((el) => el.remove());
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
  closeAnyPopover();
  if (!res.ok) return;
  await refreshBookmarks(videoId);
}

async function deleteNote(bookmarkId) {
  const videoId = readingVideoId;
  await fetch(`${BACKEND}/bookmarks/${bookmarkId}`, { method: 'DELETE' });
  closeAnyPopover();
  await refreshBookmarks(videoId);
}

async function refreshBookmarks(videoId) {
  const res = await fetch(`${BACKEND}/videos/${encodeURIComponent(videoId)}/bookmarks`);
  const bookmarks = res.ok ? await res.json() : [];
  bookmarksByVideo.set(videoId, bookmarks);

  const video = videos.find((v) => v.id === videoId);
  if (video) video.bookmark_count = bookmarks.length;

  if (readingVideoId === videoId) renderReading();
}

document.getElementById('rd-article').addEventListener('click', (e) => {
  const icon = e.target.closest('.rd-bm-icon');
  if (!icon) return;
  openNotePopover(icon.closest('.rd-seg-wrap'));
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
