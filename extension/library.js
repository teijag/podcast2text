const BACKEND = 'http://localhost:8765';

const BOOKMARK_ICON = `
  <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor" stroke="none">
    <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"></path>
  </svg>
`;

const PLAY_ICON = `
  <svg width="22" height="22" viewBox="0 0 24 24" fill="rgba(255,255,255,0.5)">
    <polygon points="8 5 19 12 8 19"></polygon>
  </svg>
`;

const THUMB_GRADIENTS = [
  'linear-gradient(135deg,#3a2f18,#171717)',
  'linear-gradient(135deg,#1a2a30,#141414)',
  'linear-gradient(135deg,#231a30,#141414)',
  'linear-gradient(135deg,#1a3024,#141414)',
  'linear-gradient(135deg,#301a1a,#141414)',
];

let videos = [];
let bookmarksByVideo = new Map(); // videoId -> bookmarks[]
let selectedVideoId = null;
let searchQuery = '';

function formatTimestamp(seconds) {
  const total = Math.max(0, Math.floor(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = h > 0 ? String(m).padStart(2, '0') : String(m);
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
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

  if (videos.length > 0) selectedVideoId = videos[0].id;
  renderGrid();
  renderDetail();
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

function renderGrid() {
  const grid = document.getElementById('lib-grid');
  const visible = videos.filter(matchesSearch);

  if (visible.length === 0) {
    grid.innerHTML = `<div class="lib-empty">No videos match "${escapeHtml(searchQuery)}".</div>`;
    return;
  }

  grid.innerHTML = visible
    .map((v, i) => {
      const gradient = THUMB_GRADIENTS[i % THUMB_GRADIENTS.length];
      const selected = v.id === selectedVideoId;
      const bookmarkBadge =
        v.bookmark_count > 0
          ? `<div class="lib-card-bm-badge">${BOOKMARK_ICON}<span>${v.bookmark_count}</span></div>`
          : '';
      const durationBadge =
        v.duration_seconds != null
          ? `<div class="lib-card-duration">${formatTimestamp(v.duration_seconds)}</div>`
          : '';
      return `
        <div class="lib-card ${selected ? 'lib-card--selected' : ''}" data-video-id="${v.id}">
          <div class="lib-card-thumb" style="background:${gradient}">
            ${PLAY_ICON}
            ${bookmarkBadge}
            ${durationBadge}
          </div>
          <div class="lib-card-info">
            <div class="lib-card-title">${escapeHtml(v.title || v.id)}</div>
            <div class="lib-card-channel">${escapeHtml(v.channel || '')}</div>
            <div class="lib-card-meta">${
              v.bookmark_count > 0 ? `${v.bookmark_count} bookmark${v.bookmark_count === 1 ? '' : 's'}` : 'No bookmarks'
            }</div>
          </div>
        </div>
      `;
    })
    .join('');

  grid.querySelectorAll('.lib-card').forEach((card) => {
    card.addEventListener('click', () => {
      selectedVideoId = card.dataset.videoId;
      renderGrid();
      renderDetail();
    });
  });
}

function renderDetail() {
  const detail = document.getElementById('lib-detail');
  const video = videos.find((v) => v.id === selectedVideoId);
  if (!video) {
    detail.innerHTML = `<div class="lib-empty">Select a video to see its bookmarks.</div>`;
    return;
  }

  const bookmarks = bookmarksByVideo.get(video.id) || [];
  const bookmarkRows = bookmarks.length
    ? bookmarks
        .map(
          (b) => `
        <div class="lib-bm-row" data-timestamp="${b.timestamp_seconds}">
          <span class="lib-bm-time">${formatTimestamp(b.timestamp_seconds)}</span>
          <span class="lib-bm-comment">${escapeHtml(b.comment) || '<span class="lib-bm-empty">No note</span>'}</span>
          <svg class="lib-bm-jump" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#6a6a6a" stroke-width="2" stroke-linecap="round">
            <line x1="7" y1="17" x2="17" y2="7"></line><polyline points="7 7 17 7 17 17"></polyline>
          </svg>
        </div>
      `
        )
        .join('')
    : `<div class="lib-empty">No bookmarks on this video yet.</div>`;

  detail.innerHTML = `
    <div class="lib-detail-header">
      <div class="lib-detail-thumb" style="background:${THUMB_GRADIENTS[0]}"></div>
      <div>
        <div class="lib-detail-title">${escapeHtml(video.title || video.id)}</div>
        <div class="lib-detail-meta">${escapeHtml(video.channel || '')}${
          video.duration_seconds != null ? ` &middot; ${formatTimestamp(video.duration_seconds)}` : ''
        }</div>
      </div>
    </div>
    <div class="lib-open-transcript" id="lib-open-transcript">
      Open transcript
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#F2B33D" stroke-width="2" stroke-linecap="round">
        <line x1="7" y1="17" x2="17" y2="7"></line><polyline points="7 7 17 7 17 17"></polyline>
      </svg>
    </div>
    <div class="lib-bm-label">Bookmarks &middot; ${bookmarks.length}</div>
    <div class="lib-bm-list">${bookmarkRows}</div>
  `;

  document.getElementById('lib-open-transcript').addEventListener('click', () => openVideoAt(video.id, null));
  detail.querySelectorAll('.lib-bm-row').forEach((row) => {
    row.addEventListener('click', () => openVideoAt(video.id, Number(row.dataset.timestamp)));
  });
}

document.getElementById('lib-search-input').addEventListener('input', (e) => {
  searchQuery = e.target.value.trim().toLowerCase();
  renderGrid();
});

loadLibrary().catch((err) => {
  document.getElementById('lib-grid').innerHTML = `<div class="lib-empty lib-error">Could not reach the local backend. Is it running?<br>(${escapeHtml(err.message)})</div>`;
});
