export const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;

export const DEFAULT_MORE_URL = 'https://www.aftonbladet.se';

export function resolveMoreUrl(raw) {
  if (!raw) return DEFAULT_MORE_URL;
  return /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
}

// Accepts a bare 11-char video ID, or a full YouTube URL in any of its
// common shapes (watch?v=, youtu.be/, /shorts/, /embed/, /live/), tolerating
// a missing scheme and extra query params. Returns null if nothing matches.
export function extractVideoId(raw) {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (VIDEO_ID_RE.test(trimmed)) return trimmed;

  let url;
  try {
    url = new URL(trimmed);
  } catch {
    try {
      url = new URL(`https://${trimmed}`);
    } catch {
      return null;
    }
  }

  const host = url.hostname.replace(/^www\./, '');

  if (host === 'youtu.be') {
    const id = url.pathname.slice(1).split('/')[0];
    return VIDEO_ID_RE.test(id) ? id : null;
  }

  if (host === 'youtube.com' || host === 'm.youtube.com' || host === 'music.youtube.com') {
    const vParam = url.searchParams.get('v');
    if (vParam && VIDEO_ID_RE.test(vParam)) return vParam;

    const segments = url.pathname.split('/').filter(Boolean);
    const kindIndex = segments.findIndex((seg) => seg === 'shorts' || seg === 'embed' || seg === 'live');
    if (kindIndex !== -1 && VIDEO_ID_RE.test(segments[kindIndex + 1])) {
      return segments[kindIndex + 1];
    }
  }

  return null;
}

// Parses the query params the player page reads. Takes a URLSearchParams
// rather than reading window.location.search directly, so the create page
// can reuse this for edit mode against its own query string.
export function parseClipParams(search) {
  const v = search.get('v');
  const start = Number(search.get('start') ?? search.get('s'));
  const end = Number(search.get('end') ?? search.get('e'));
  const url = resolveMoreUrl(search.get('url'));

  if (!v || !VIDEO_ID_RE.test(v)) {
    return { error: 'Missing or invalid "v" parameter: expected an 11-character YouTube video ID.' };
  }
  if (!Number.isFinite(start) || start < 0) {
    return { error: 'Missing or invalid "start"/"s" parameter: expected a number of seconds >= 0.' };
  }
  if (!Number.isFinite(end) || end <= start) {
    return { error: 'Missing or invalid "end"/"e" parameter: expected a number of seconds greater than "start"/"s".' };
  }

  return { videoId: v, start, end, url };
}

// Builds a link to the player page. Targets the directory root ("./") rather
// than the literal "index.html" — servers that rewrite clean URLs (e.g. the
// "serve" package this repo's npm run dev uses) 301-redirect a direct
// index.html request and drop the query string on the way, which would
// silently break every generated link. "./" resolves to the same file
// without tripping that rewrite. Omits "start" when it's 0 and "url" when
// it's the default, since both are optional on the reading side.
export function buildShareUrl({ videoId, start, end, moreUrl }, base = window.location.href) {
  const url = new URL('.', base);
  url.searchParams.set('v', videoId);
  if (start) url.searchParams.set('start', String(start));
  url.searchParams.set('end', String(end));
  if (moreUrl && moreUrl !== DEFAULT_MORE_URL) url.searchParams.set('url', moreUrl);
  return url.toString();
}
