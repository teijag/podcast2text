const BACKEND = 'http://localhost:8765';

async function getTranscript(videoId) {
  const res = await fetch(`${BACKEND}/videos/${encodeURIComponent(videoId)}/transcript`);
  if (res.status === 404) return { ok: false, notFound: true };
  if (!res.ok) return { ok: false, error: `Backend error ${res.status}` };
  return { ok: true, data: await res.json() };
}

async function transcribe(url) {
  const res = await fetch(`${BACKEND}/transcribe`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    return { ok: false, error: body.detail || `Backend error ${res.status}` };
  }
  return { ok: true, data: await res.json() };
}

async function listBookmarks(videoId) {
  const res = await fetch(`${BACKEND}/videos/${encodeURIComponent(videoId)}/bookmarks`);
  if (!res.ok) return { ok: false, error: `Backend error ${res.status}` };
  return { ok: true, data: await res.json() };
}

async function createBookmark(videoId, timestampSeconds, comment) {
  const res = await fetch(`${BACKEND}/bookmarks`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ video_id: videoId, timestamp_seconds: timestampSeconds, comment }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    return { ok: false, error: body.detail || `Backend error ${res.status}` };
  }
  return { ok: true, data: await res.json() };
}

async function deleteBookmark(bookmarkId) {
  const res = await fetch(`${BACKEND}/bookmarks/${encodeURIComponent(bookmarkId)}`, {
    method: 'DELETE',
  });
  if (!res.ok) return { ok: false, error: `Backend error ${res.status}` };
  return { ok: true };
}

async function translate(videoId, items) {
  const res = await fetch(`${BACKEND}/translate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ video_id: videoId, items }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    return { ok: false, error: body.detail || `Backend error ${res.status}` };
  }
  return { ok: true, data: await res.json() };
}

async function markViewed(videoId) {
  const res = await fetch(`${BACKEND}/videos/${encodeURIComponent(videoId)}/viewed`, {
    method: 'POST',
  });
  if (!res.ok) return { ok: false, error: `Backend error ${res.status}` };
  return { ok: true };
}

function openLibrary() {
  chrome.tabs.create({ url: chrome.runtime.getURL('library.html') });
}

chrome.action.onClicked.addListener(openLibrary);

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === 'OPEN_LIBRARY') {
    openLibrary();
    return false; // fire-and-forget, no response expected
  }

  const handler =
    message.type === 'GET_TRANSCRIPT' ? getTranscript(message.videoId) :
    message.type === 'TRANSCRIBE' ? transcribe(message.url) :
    message.type === 'LIST_BOOKMARKS' ? listBookmarks(message.videoId) :
    message.type === 'CREATE_BOOKMARK' ? createBookmark(message.videoId, message.timestampSeconds, message.comment) :
    message.type === 'DELETE_BOOKMARK' ? deleteBookmark(message.bookmarkId) :
    message.type === 'MARK_VIEWED' ? markViewed(message.videoId) :
    message.type === 'TRANSLATE' ? translate(message.videoId, message.items) :
    null;

  if (!handler) return false;

  handler
    .then(sendResponse)
    .catch((err) => sendResponse({ ok: false, error: String(err) }));
  return true; // keep the message channel open for the async response
});
