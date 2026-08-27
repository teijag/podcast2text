const TRANSCRIPT_ICON = `
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#0f0f0f" stroke-width="2.2" stroke-linecap="round">
    <line x1="4" y1="7" x2="20" y2="7"></line>
    <line x1="4" y1="12" x2="15" y2="12"></line>
    <line x1="4" y1="17" x2="18" y2="17"></line>
  </svg>
`;

const BOOKMARK_ICON_OUTLINE = `
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
    <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"></path>
  </svg>
`;

const BOOKMARK_ICON_FILLED = `
  <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" stroke="none">
    <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"></path>
  </svg>
`;

// Map<segment start seconds, bookmark {id, comment}> for the currently rendered transcript.
let bookmarksByStart = new Map();
// Map<raw Whisper segment start, the sentence line's own start> — a bookmark
// may reference any segment within a sentence, not just the sentence's first.
let sentenceStartBySegStart = new Map();
let panelTab = 'transcript'; // 'transcript' | 'bookmarks'
let searchQuery = '';

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

let currentVideoId = null;
let panelEl = null;

// Video-sync state, cleared whenever we re-render or navigate away.
let syncVideoEl = null;
let syncTimeUpdateHandler = null;
let syncSegments = null;
let syncActiveIndex = -1;

function formatTimestamp(seconds) {
  const total = Math.max(0, Math.floor(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = h > 0 ? String(m).padStart(2, '0') : String(m);
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

function findVideoElement() {
  return document.querySelector('#movie_player video');
}

function stopVideoSync() {
  if (syncVideoEl && syncTimeUpdateHandler) {
    syncVideoEl.removeEventListener('timeupdate', syncTimeUpdateHandler);
  }
  syncVideoEl = null;
  syncTimeUpdateHandler = null;
  syncSegments = null;
  syncActiveIndex = -1;
}

function findActiveIndex(segments, currentTime) {
  // Segments are ordered by start time; the active one is the last whose
  // start is at or before currentTime.
  let idx = -1;
  for (let i = 0; i < segments.length; i++) {
    if (segments[i].start <= currentTime) idx = i;
    else break;
  }
  return idx;
}

function setActiveLine(index) {
  if (index === syncActiveIndex) return;
  const list = panelEl && panelEl.querySelector('.p2t-list');
  if (!list) return;

  const prev = list.querySelector('.p2t-line--active');
  if (prev) prev.classList.remove('p2t-line--active');

  syncActiveIndex = index;
  if (index < 0) return;

  const next = list.querySelector(`.p2t-line[data-index="${index}"]`);
  if (next) {
    next.classList.add('p2t-line--active');
    next.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }
}

function startVideoSync(videoId, segments, attempt = 0) {
  if (videoId !== currentVideoId) return; // navigated away while waiting for the player

  const video = findVideoElement();
  if (!video) {
    if (attempt < 10) setTimeout(() => startVideoSync(videoId, segments, attempt + 1), 300);
    return;
  }

  stopVideoSync();
  syncVideoEl = video;
  syncSegments = segments;
  syncTimeUpdateHandler = () => {
    setActiveLine(findActiveIndex(syncSegments, syncVideoEl.currentTime));
  };
  video.addEventListener('timeupdate', syncTimeUpdateHandler);
  setActiveLine(findActiveIndex(segments, video.currentTime));
}

function getVideoId() {
  return new URLSearchParams(location.search).get('v');
}

function fireAndForget(message) {
  // No callback registered, so there's nothing for Chrome to complain about
  // if this tab navigates away before the background script responds.
  try {
    chrome.runtime.sendMessage(message);
  } catch (_e) {
    // Extension context can be invalidated (e.g. reload) mid-navigation; harmless here.
  }
}

function backendMessage(message) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(message, (response) => {
      if (chrome.runtime.lastError) {
        resolve({ ok: false, error: chrome.runtime.lastError.message });
        return;
      }
      resolve(response);
    });
  });
}

function isYouTubeDark() {
  return document.documentElement.hasAttribute('dark');
}

function applyTheme() {
  if (panelEl) panelEl.classList.toggle('p2t-light', !isYouTubeDark());
}

function removePanel() {
  stopVideoSync();
  if (panelEl) {
    panelEl.remove();
    panelEl = null;
  }
}

function ensurePanel() {
  if (panelEl && panelEl.isConnected) return panelEl;
  const secondary = document.getElementById('secondary-inner');
  if (!secondary) return null;
  panelEl = document.createElement('div');
  panelEl.id = 'p2t-panel';
  applyTheme();
  panelEl.innerHTML = `
    <div class="p2t-header">
      <div class="p2t-badge">${TRANSCRIPT_ICON}</div>
      <span class="p2t-title">Transcript</span>
      <button class="p2t-library-btn" type="button" title="Open Library">
        Library
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
          <line x1="7" y1="17" x2="17" y2="7"></line><polyline points="7 7 17 7 17 17"></polyline>
        </svg>
      </button>
    </div>
    <div class="p2t-body"></div>
  `;
  panelEl.querySelector('.p2t-library-btn').addEventListener('click', () => {
    fireAndForget({ type: 'OPEN_LIBRARY' });
  });
  secondary.prepend(panelEl);
  return panelEl;
}

function setBody(html) {
  const panel = ensurePanel();
  if (!panel) return null;
  const body = panel.querySelector('.p2t-body');
  body.innerHTML = html;
  return body;
}

function renderIdle(videoId) {
  stopVideoSync();
  const body = setBody(`<button class="p2t-transcribe-btn">Transcribe this video</button>`);
  if (!body) return;
  body.querySelector('.p2t-transcribe-btn').addEventListener('click', () => startTranscription(videoId));
}

function renderLoading() {
  stopVideoSync();
  setBody(`<div class="p2t-status">Transcribing… this can take a minute.</div>`);
}

function renderError(message) {
  stopVideoSync();
  setBody(`<div class="p2t-status p2t-error">${message}</div>`);
}

function renderReady(transcript) {
  const sentences = groupIntoSentences(transcript.segments);
  bookmarksByStart = new Map();
  sentenceStartBySegStart = new Map();
  for (const sent of sentences) {
    for (const segStart of sent.segmentStarts) sentenceStartBySegStart.set(segStart, sent.start);
  }
  panelTab = 'transcript';
  searchQuery = '';

  const lines = sentences
    .map(
      (sent, i) => `
      <div class="p2t-line" data-index="${i}" data-start="${sent.start}">
        <span class="p2t-line-time">${formatTimestamp(sent.start)}</span>
        <span class="p2t-line-text">${escapeHtml(sent.text)}</span>
        <button class="p2t-bm-icon" type="button" title="Bookmark this moment">${BOOKMARK_ICON_OUTLINE}</button>
      </div>
    `
    )
    .join('');

  const body = setBody(`
    <div class="p2t-tabs">
      <button class="p2t-tab p2t-tab--active" data-tab="transcript">Transcript</button>
      <button class="p2t-tab" data-tab="bookmarks">Bookmarks &middot; <span class="p2t-bm-count">0</span></button>
    </div>
    <div class="p2t-search">
      <input type="text" class="p2t-search-input" placeholder="Search transcript">
    </div>
    <div class="p2t-list">${lines}</div>
  `);
  if (!body) return;

  const list = body.querySelector('.p2t-list');
  list.addEventListener('click', (e) => {
    const bmIcon = e.target.closest('.p2t-bm-icon');
    if (bmIcon) {
      onBookmarkIconClick(bmIcon.closest('.p2t-line'));
      return;
    }
    const line = e.target.closest('.p2t-line');
    if (!line || !syncVideoEl) return;
    syncVideoEl.currentTime = Number(line.dataset.start);
  });

  body.querySelectorAll('.p2t-tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      panelTab = tab.dataset.tab;
      body.querySelectorAll('.p2t-tab').forEach((t) => t.classList.toggle('p2t-tab--active', t === tab));
      body.querySelector('.p2t-search').style.display = panelTab === 'transcript' ? '' : 'none';
      applyLineFilters(body);
    });
  });

  body.querySelector('.p2t-search-input').addEventListener('input', (e) => {
    searchQuery = e.target.value.trim().toLowerCase();
    applyLineFilters(body);
  });

  startVideoSync(currentVideoId, sentences);
  loadBookmarks(currentVideoId, body);
  fireAndForget({ type: 'MARK_VIEWED', videoId: currentVideoId });
}

function applyLineFilters(body) {
  const lines = body.querySelectorAll('.p2t-line');
  lines.forEach((line) => {
    const isBookmarked = line.classList.contains('p2t-line--bookmarked');
    const matchesTab = panelTab === 'transcript' || isBookmarked;
    const matchesSearch =
      panelTab === 'bookmarks' ||
      !searchQuery ||
      line.querySelector('.p2t-line-text').textContent.toLowerCase().includes(searchQuery);
    const visible = matchesTab && matchesSearch;

    line.classList.toggle('p2t-line--hidden', !visible);
    const commentEl = line.nextElementSibling;
    if (commentEl && commentEl.classList.contains('p2t-line-comment')) {
      commentEl.classList.toggle('p2t-line--hidden', !visible);
    }
  });
}

function updateBookmarkCount(body) {
  const el = body && body.querySelector('.p2t-bm-count');
  if (el) el.textContent = bookmarksByStart.size;
}

async function loadBookmarks(videoId, body) {
  const list = body.querySelector('.p2t-list');
  const res = await backendMessage({ type: 'LIST_BOOKMARKS', videoId });
  if (videoId !== currentVideoId || !res.ok) return;
  for (const bm of res.data) {
    bookmarksByStart.set(bm.timestamp_seconds, bm);
    const lineStart = sentenceStartBySegStart.get(bm.timestamp_seconds);
    const line = lineStart != null ? list.querySelector(`.p2t-line[data-start="${lineStart}"]`) : null;
    if (line) markLineBookmarked(line, bm);
  }
  updateBookmarkCount(body);
  applyLineFilters(body);
}

function markLineBookmarked(lineEl, bookmark) {
  lineEl.classList.add('p2t-line--bookmarked');
  lineEl.dataset.bookmarkId = bookmark.id;
  lineEl.querySelector('.p2t-bm-icon').innerHTML = BOOKMARK_ICON_FILLED;
  setLineComment(lineEl, bookmark.comment);
}

function markLineUnbookmarked(lineEl) {
  lineEl.classList.remove('p2t-line--bookmarked');
  delete lineEl.dataset.bookmarkId;
  lineEl.querySelector('.p2t-bm-icon').innerHTML = BOOKMARK_ICON_OUTLINE;
  setLineComment(lineEl, null);
}

function setLineComment(lineEl, comment) {
  const existing = lineEl.nextElementSibling;
  const hasCommentEl = existing && existing.classList.contains('p2t-line-comment');
  if (!comment) {
    if (hasCommentEl) existing.remove();
    return;
  }
  if (hasCommentEl) {
    existing.textContent = comment;
    return;
  }
  const commentEl = document.createElement('div');
  commentEl.className = 'p2t-line-comment';
  commentEl.textContent = comment;
  lineEl.after(commentEl);
}

function onBookmarkIconClick(lineEl) {
  if (!lineEl) return;
  if (lineEl.classList.contains('p2t-line--bookmarked')) {
    removeBookmark(lineEl);
  } else {
    openBookmarkPopover(lineEl);
  }
}

function openBookmarkPopover(lineEl) {
  const existing = lineEl.nextElementSibling;
  if (existing && existing.classList.contains('p2t-bm-popover')) return; // already open

  const popover = document.createElement('div');
  popover.className = 'p2t-bm-popover';
  popover.innerHTML = `
    <textarea class="p2t-bm-input" placeholder="What's worth remembering here?"></textarea>
    <div class="p2t-bm-actions">
      <button type="button" class="p2t-bm-cancel">Cancel</button>
      <button type="button" class="p2t-bm-save">Save</button>
    </div>
  `;
  lineEl.after(popover);

  const textarea = popover.querySelector('.p2t-bm-input');
  textarea.focus();

  popover.querySelector('.p2t-bm-cancel').addEventListener('click', () => popover.remove());
  popover.querySelector('.p2t-bm-save').addEventListener('click', () =>
    saveBookmark(lineEl, popover, textarea.value.trim())
  );
}

async function saveBookmark(lineEl, popover, comment) {
  const videoId = currentVideoId;
  const timestampSeconds = Number(lineEl.dataset.start);
  const res = await backendMessage({
    type: 'CREATE_BOOKMARK',
    videoId,
    timestampSeconds,
    comment: comment || null,
  });
  if (videoId !== currentVideoId) return; // navigated away while saving
  popover.remove();
  if (res.ok) {
    bookmarksByStart.set(timestampSeconds, res.data);
    markLineBookmarked(lineEl, res.data);
    const body = panelEl && panelEl.querySelector('.p2t-body');
    if (body) {
      updateBookmarkCount(body);
      applyLineFilters(body);
    }
  }
}

async function removeBookmark(lineEl) {
  const bookmarkId = lineEl.dataset.bookmarkId;
  if (!bookmarkId) return;
  const videoId = currentVideoId;
  const res = await backendMessage({ type: 'DELETE_BOOKMARK', bookmarkId: Number(bookmarkId) });
  if (videoId !== currentVideoId) return; // navigated away while deleting
  if (res.ok) {
    for (const [key, bm] of bookmarksByStart) {
      if (String(bm.id) === bookmarkId) bookmarksByStart.delete(key);
    }
    markLineUnbookmarked(lineEl);
    const body = panelEl && panelEl.querySelector('.p2t-body');
    if (body) {
      updateBookmarkCount(body);
      applyLineFilters(body);
    }
  }
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

async function startTranscription(videoId) {
  renderLoading();
  const url = `https://www.youtube.com/watch?v=${videoId}`;
  const res = await backendMessage({ type: 'TRANSCRIBE', url });
  if (currentVideoId !== videoId) return; // navigated away while waiting
  if (res.ok) {
    renderReady(res.data);
  } else {
    renderError(res.error || 'Could not reach the local backend. Is it running?');
  }
}

async function loadForVideo(videoId) {
  currentVideoId = videoId;
  renderIdle(videoId); // show idle state immediately while checking for an existing transcript
  const res = await backendMessage({ type: 'GET_TRANSCRIPT', videoId });
  if (currentVideoId !== videoId) return; // navigated away while waiting
  if (res.ok) {
    renderReady(res.data);
  } else if (!res.notFound) {
    renderError(res.error || 'Could not reach the local backend. Is it running?');
  }
}

function onPossibleNavigation() {
  const videoId = getVideoId();
  if (!videoId) {
    removePanel();
    currentVideoId = null;
    return;
  }
  if (videoId === currentVideoId && panelEl && panelEl.isConnected) return;
  loadForVideo(videoId);
}

document.addEventListener('yt-navigate-finish', onPossibleNavigation);

// YouTube is a heavy client-rendered SPA: on a fresh page load the content
// script can run before YouTube's own JS has built out #secondary-inner, so
// the very first check can miss it. React the instant it (or anything else
// relevant) gets added, instead of waiting on the poll below.
let checkScheduled = false;
function scheduleCheck() {
  if (checkScheduled) return;
  checkScheduled = true;
  requestAnimationFrame(() => {
    checkScheduled = false;
    onPossibleNavigation();
  });
}
new MutationObserver(scheduleCheck).observe(document.documentElement, {
  childList: true,
  subtree: true,
});

// Slow fallback in case the observer ever misses a change.
setInterval(onPossibleNavigation, 1500);
onPossibleNavigation();

// Match YouTube's own light/dark theme, and keep matching it live if the
// user toggles it from YouTube's settings menu while the page stays open.
new MutationObserver(applyTheme).observe(document.documentElement, {
  attributes: true,
  attributeFilter: ['dark'],
});
applyTheme();
