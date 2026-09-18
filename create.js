import { extractVideoId, parseClipParams, buildShareUrl, resolveMoreUrl } from './clip-url.js';
import { applyBarImageVars, stagePlayerVars, createStingSequence } from './sting.js';

const MIN_GAP_SECONDS = 0.5;
const STEP_SECONDS = 0.1;
const COARSE_STEP_SECONDS = 5;
const PREVIEW_LEAD_SECONDS = 3;
const DURATION_POLL_INTERVAL_MS = 150;
const DURATION_POLL_MAX_ATTEMPTS = 40; // ~6s

const videoInput = document.getElementById('video-input');
const loadButton = document.getElementById('load-button');
const videoErrorEl = document.getElementById('video-error');

const stageEl = document.getElementById('stage');
const overlayEl = document.getElementById('overlay');
const barLinkEl = document.getElementById('bar-link');
const scrimEl = document.getElementById('scrim');
const stingAudio = document.getElementById('sting');

const clipControlsEl = document.getElementById('clip-controls');
const rangeEl = document.getElementById('range');
const thumbStart = document.getElementById('thumb-start');
const thumbEnd = document.getElementById('thumb-end');
const startInput = document.getElementById('start-input');
const endInput = document.getElementById('end-input');
const durationNoteEl = document.getElementById('duration-note');
const moreUrlInput = document.getElementById('more-url-input');
const previewButton = document.getElementById('preview-button');
const shareLinkInput = document.getElementById('share-link-input');
const copyButton = document.getElementById('copy-button');
const openLink = document.getElementById('open-link');

let player = null;
let sequence = null;
let currentVideoId = null;
let duration = 0;
let clip = { start: 0, end: 0 };
let pendingEditParams = null;
let pendingSeekSeconds = null;
let seekScheduled = false;

applyBarImageVars();

function round2(n) {
  return Math.round(n * 100) / 100;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function formatClock(seconds) {
  const s = Math.max(0, seconds);
  const mins = Math.floor(s / 60);
  const secs = (s % 60).toFixed(1).padStart(4, '0');
  return `${mins}:${secs}`;
}

function showVideoError(message) {
  videoErrorEl.textContent = message;
  videoErrorEl.hidden = false;
}

function hideVideoError() {
  videoErrorEl.hidden = true;
}

function setStageState(state, message) {
  stageEl.hidden = false;
  stageEl.dataset.state = state;
  if (state === 'ready') {
    scrimEl.hidden = true;
    clipControlsEl.hidden = false;
  } else {
    scrimEl.hidden = false;
    clipControlsEl.hidden = true;
    scrimEl.textContent = message || (state === 'loading' ? 'Loading…' : 'Something went wrong.');
  }
}

function scheduleSeek(seconds) {
  pendingSeekSeconds = seconds;
  if (seekScheduled) return;
  seekScheduled = true;
  requestAnimationFrame(() => {
    seekScheduled = false;
    if (pendingSeekSeconds === null || !player) return;
    player.seekTo(pendingSeekSeconds, true);
    // Defensive: seekTo on a still-cued/unstarted player can start playback
    // (a documented YouTube API quirk) rather than just displaying the frame.
    if (player.getPlayerState && player.getPlayerState() !== 2 /* PAUSED */) {
      player.pauseVideo();
    }
    pendingSeekSeconds = null;
  });
}

function updateShareLink() {
  if (!currentVideoId) return;
  const moreUrl = moreUrlInput.value.trim() || undefined;
  const href = buildShareUrl({ videoId: currentVideoId, start: clip.start, end: clip.end, moreUrl });
  shareLinkInput.value = href;
  openLink.href = href;
  barLinkEl.href = resolveMoreUrl(moreUrl);
}

// Single funnel for every mutation of the clip's start/end — dragging,
// keyboard, typed input, URL prefill, or the post-duration default. Keeps
// the slider, the number inputs, aria state, and the share link in sync
// without needing a dirty flag: writing .value directly fires no events, so
// there's no update loop to guard against — only the field currently being
// typed into must not be clobbered mid-keystroke (that's what `source` is for).
function setClip({ start, end }, source) {
  // Any clip edit invalidates whatever the overlay is currently showing —
  // without this, dragging/typing after a completed preview would scrub the
  // video underneath a bar that's stuck showing the last sting.
  if (sequence && overlayEl.dataset.visible) sequence.reset();

  const movedField = start !== undefined ? 'start' : 'end';

  let nextStart = start !== undefined ? clamp(start, 0, duration) : clip.start;
  let nextEnd = end !== undefined ? clamp(end, 0, duration) : clip.end;

  if (movedField === 'start') {
    nextStart = clamp(nextStart, 0, nextEnd - MIN_GAP_SECONDS);
  } else {
    nextEnd = clamp(nextEnd, nextStart + MIN_GAP_SECONDS, duration);
  }

  clip = { start: round2(nextStart), end: round2(nextEnd) };

  const startPct = duration > 0 ? (clip.start / duration) * 100 : 0;
  const endPct = duration > 0 ? (clip.end / duration) * 100 : 0;
  rangeEl.style.setProperty('--start-pct', `${startPct}%`);
  rangeEl.style.setProperty('--end-pct', `${endPct}%`);

  thumbStart.setAttribute('aria-valuemax', String(duration));
  thumbStart.setAttribute('aria-valuenow', String(clip.start));
  thumbStart.setAttribute('aria-valuetext', formatClock(clip.start));
  thumbEnd.setAttribute('aria-valuemax', String(duration));
  thumbEnd.setAttribute('aria-valuenow', String(clip.end));
  thumbEnd.setAttribute('aria-valuetext', formatClock(clip.end));

  if (source !== 'start-input') startInput.value = clip.start;
  if (source !== 'end-input') endInput.value = clip.end;

  updateShareLink();
  scheduleSeek(movedField === 'end' ? clip.end : clip.start);
}

function onDurationReady(newDuration) {
  duration = newDuration;
  setStageState('ready');

  rangeEl.removeAttribute('data-disabled');
  thumbStart.tabIndex = 0;
  thumbEnd.tabIndex = 0;
  startInput.disabled = false;
  endInput.disabled = false;
  previewButton.disabled = false;
  durationNoteEl.textContent = `/ ${formatClock(duration)}`;

  if (pendingEditParams && pendingEditParams.videoId === currentVideoId) {
    setClip({ start: pendingEditParams.start, end: pendingEditParams.end }, 'init');
    pendingEditParams = null;
  } else {
    setClip({ start: 0, end: Math.min(duration, 10) }, 'init');
  }
}

function warmUpAndResolveDuration() {
  setStageState('loading');
  // A never-started ("cued") player reports duration 0 and can jump straight
  // into playback on the first seekTo. Nudging it into PLAYING (muted) and
  // straight back to PAUSED is what makes duration and scrubbing reliable.
  player.mute();
  player.playVideo();

  let attempts = 0;
  function poll() {
    const currentDuration = player.getDuration ? player.getDuration() : 0;
    if (currentDuration > 0) {
      player.pauseVideo();
      player.unMute();
      onDurationReady(currentDuration);
      return;
    }
    attempts += 1;
    if (attempts >= DURATION_POLL_MAX_ATTEMPTS) {
      player.pauseVideo();
      player.unMute();
      setStageState('error', "Couldn't read this video's length — try a different video.");
      return;
    }
    setTimeout(poll, DURATION_POLL_INTERVAL_MS);
  }
  poll();
}

function describePlayerError(code) {
  switch (code) {
    case 2: return 'Invalid video ID.';
    case 100: return 'Video not found.';
    case 101:
    case 150: return "This video's owner doesn't allow it to be embedded.";
    default: return 'That video is unavailable or cannot be embedded.';
  }
}

function onPlayerError(event) {
  setStageState('error', describePlayerError(event.data));
}

function loadVideo(videoId) {
  hideVideoError();
  currentVideoId = videoId;
  barLinkEl.href = '';

  if (!player) {
    setStageState('loading');
    player = new YT.Player('player', {
      width: '800',
      height: '450',
      videoId,
      playerVars: stagePlayerVars(),
      events: {
        onReady: () => {
          sequence = createStingSequence({ player, overlayEl, audioEl: stingAudio });
          warmUpAndResolveDuration();
        },
        onError: onPlayerError,
      },
    });
    return;
  }

  setStageState('loading');
  sequence.reset();
  player.cueVideoById(videoId);
  warmUpAndResolveDuration();
}

function requestLoad(videoId) {
  if (window.YT && window.YT.Player) {
    loadVideo(videoId);
  } else {
    window.onYouTubeIframeAPIReady = () => loadVideo(videoId);
  }
}

function onLoadClick() {
  const id = extractVideoId(videoInput.value);
  if (!id) {
    showVideoError('Enter a valid YouTube URL or 11-character video ID.');
    return;
  }
  requestLoad(id);
}

loadButton.addEventListener('click', onLoadClick);
videoInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') onLoadClick();
});

// --- Dual-handle slider: pointer + keyboard -------------------------------

function secondsFromClientX(clientX) {
  const rect = rangeEl.getBoundingClientRect();
  const fraction = clamp((clientX - rect.left) / rect.width, 0, 1);
  return fraction * duration;
}

function onThumbPointerDown(e, which) {
  if (rangeEl.hasAttribute('data-disabled')) return;
  const thumb = which === 'start' ? thumbStart : thumbEnd;
  thumb.setPointerCapture(e.pointerId);
  rangeEl.dataset.dragging = which;

  function onMove(moveEvent) {
    const seconds = secondsFromClientX(moveEvent.clientX);
    setClip(which === 'start' ? { start: seconds } : { end: seconds }, `${which}-drag`);
  }
  function onUp() {
    thumb.removeEventListener('pointermove', onMove);
    thumb.removeEventListener('pointerup', onUp);
    thumb.removeEventListener('pointercancel', onUp);
    delete rangeEl.dataset.dragging;
  }
  thumb.addEventListener('pointermove', onMove);
  thumb.addEventListener('pointerup', onUp);
  thumb.addEventListener('pointercancel', onUp);
}

thumbStart.addEventListener('pointerdown', (e) => onThumbPointerDown(e, 'start'));
thumbEnd.addEventListener('pointerdown', (e) => onThumbPointerDown(e, 'end'));

function onThumbKeydown(e, which) {
  if (rangeEl.hasAttribute('data-disabled')) return;
  const current = which === 'start' ? clip.start : clip.end;
  let next = current;

  switch (e.key) {
    case 'ArrowLeft':
    case 'ArrowDown':
      next = current - (e.shiftKey ? COARSE_STEP_SECONDS : STEP_SECONDS);
      break;
    case 'ArrowRight':
    case 'ArrowUp':
      next = current + (e.shiftKey ? COARSE_STEP_SECONDS : STEP_SECONDS);
      break;
    case 'PageDown':
      next = current - COARSE_STEP_SECONDS;
      break;
    case 'PageUp':
      next = current + COARSE_STEP_SECONDS;
      break;
    case 'Home':
      next = which === 'start' ? 0 : clip.start + MIN_GAP_SECONDS;
      break;
    case 'End':
      next = which === 'start' ? clip.end - MIN_GAP_SECONDS : duration;
      break;
    default:
      return;
  }

  e.preventDefault();
  setClip(which === 'start' ? { start: next } : { end: next }, `${which}-key`);
}

thumbStart.addEventListener('keydown', (e) => onThumbKeydown(e, 'start'));
thumbEnd.addEventListener('keydown', (e) => onThumbKeydown(e, 'end'));

// Clicking anywhere on the rail that isn't a thumb (track, connect fill, or
// bare padding) jumps the nearer handle there (ties go to "end"). Thumb
// clicks are handled by their own pointerdown listeners above, and bubble
// up here too, so they're explicitly excluded.
rangeEl.addEventListener('pointerdown', (e) => {
  if (e.target.closest('.range-thumb')) return;
  if (rangeEl.hasAttribute('data-disabled')) return;
  const seconds = secondsFromClientX(e.clientX);
  const which = Math.abs(seconds - clip.start) <= Math.abs(seconds - clip.end) ? 'start' : 'end';
  setClip(which === 'start' ? { start: seconds } : { end: seconds }, `${which}-drag`);
  onThumbPointerDown(e, which);
});

// --- Number inputs ---------------------------------------------------------

function onTimeInput(e, which) {
  if (e.target.value.trim() === '') return;
  const n = Number(e.target.value);
  if (!Number.isFinite(n)) return;
  setClip(which === 'start' ? { start: n } : { end: n }, `${which}-input`);
}

startInput.addEventListener('input', (e) => onTimeInput(e, 'start'));
endInput.addEventListener('input', (e) => onTimeInput(e, 'end'));
startInput.addEventListener('change', () => { startInput.value = clip.start; });
endInput.addEventListener('change', () => { endInput.value = clip.end; });

// --- "MORE" URL, preview, share link ---------------------------------------

moreUrlInput.addEventListener('input', updateShareLink);

function onPreviewClick() {
  if (!sequence || duration <= 0) return;
  sequence.reset();
  const previewStart = Math.max(clip.start, clip.end - PREVIEW_LEAD_SECONDS);
  sequence.play({ from: previewStart, end: clip.end });
}

previewButton.addEventListener('click', onPreviewClick);

async function onCopyClick() {
  try {
    await navigator.clipboard.writeText(shareLinkInput.value);
  } catch {
    shareLinkInput.select();
    document.execCommand('copy');
  }
  copyButton.dataset.copied = 'true';
  setTimeout(() => { delete copyButton.dataset.copied; }, 1500);
}

copyButton.addEventListener('click', onCopyClick);

document.addEventListener('visibilitychange', () => {
  if (document.hidden && sequence) sequence.stop();
});

// --- Edit mode: arriving with existing player params pre-fills the form ---

const initialParams = parseClipParams(new URLSearchParams(window.location.search));
if (!initialParams.error) {
  pendingEditParams = initialParams;
  videoInput.value = initialParams.videoId;
  const rawMoreUrl = new URLSearchParams(window.location.search).get('url');
  if (rawMoreUrl) moreUrlInput.value = rawMoreUrl;
  requestLoad(initialParams.videoId);
}
