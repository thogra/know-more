// Left-to-right reveal of the "full" bar over "blank", in seconds from the
// start of the sting audio, roughly synced to the words being spoken. Ends
// before the blink/flicker phase below, which is a separate flash effect
// tied to the audio's loudness peak rather than to speech.
const BAR_WIPE_START_SECONDS = 0.00;
const BAR_WIPE_END_SECONDS = 0.70;

// Blink schedule: whether the blue flash bar is shown, once the reveal above
// has finished. Derived from the sting's actual loudness envelope (loudest
// block ~0.75-1.15s). Tune these against the audio by ear/eye — nothing else
// depends on their values.
const BLINK_KEYFRAMES = [
  { t: 0.74, on: true },
  { t: 0.86, on: false },
  { t: 0.96, on: true },
  { t: 1.06, on: false },
  { t: 1.12, on: true },
];

// How long before the nominal end position to trigger the freeze, to absorb
// the postMessage/pauseVideo round-trip latency to the iframe.
const FREEZE_LEAD_SECONDS = 0.06;

// After pausing, seek back to the exact end position so the frozen frame is
// deterministic regardless of how much the pause itself overshot.
const SNAP_TO_END_FRAME = true;

const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;

const DEFAULT_MORE_URL = 'https://www.aftonbladet.se';

// Real pixel dimensions of the bar image assets (frames/bar-*.jpg). Exposed
// to CSS as custom properties so .bar-stack's aspect-ratio stays derived
// from one source instead of a second hardcoded literal.
const BAR_IMAGE_WIDTH_PX = 1920;
const BAR_IMAGE_HEIGHT_PX = 171;
document.documentElement.style.setProperty('--bar-image-width', BAR_IMAGE_WIDTH_PX);
document.documentElement.style.setProperty('--bar-image-height', BAR_IMAGE_HEIGHT_PX);

const stageEl = document.getElementById('stage');
const overlayEl = document.getElementById('overlay');
const gateEl = document.getElementById('gate');
const barLinkEl = document.getElementById('bar-link');
const errorEl = document.getElementById('error');
const stingAudio = document.getElementById('sting');

let player = null;
let endWatchHandle = null;
let barAnimHandle = null;
let params = null;
let inPlayback = false; // true from gate click through to held state; used by the visibility guard

function showError(message) {
  stageEl.hidden = true;
  errorEl.hidden = false;
  errorEl.textContent = message;
}

function resolveMoreUrl(raw) {
  if (!raw) return DEFAULT_MORE_URL;
  return /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
}

function parseParams() {
  const search = new URLSearchParams(window.location.search);
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

function setReveal(fraction) {
  overlayEl.style.setProperty('--reveal', `${fraction * 100}%`);
  // "MORE" only becomes clickable once it's fully wiped in; never reset back
  // to non-clickable afterwards (the reveal only ever runs forward once).
  if (fraction >= 1) {
    overlayEl.dataset.clickable = 'true';
  }
}

function setBlink(on) {
  overlayEl.dataset.blink = on ? 'on' : 'off';
}

function primeAudioForLaterPlayback() {
  // Must happen inside the user gesture (the gate click) so a later,
  // programmatic play() during the sting isn't blocked by autoplay policies.
  // Muted rather than volume-zeroed: iOS Safari ignores HTMLMediaElement.volume.
  stingAudio.muted = true;
  stingAudio.play().then(() => {
    stingAudio.pause();
    stingAudio.currentTime = 0;
    stingAudio.muted = false;
  }).catch(() => {
    // Some browsers may still reject this priming play; the later real
    // play() call at sting time is still attempted regardless.
    stingAudio.muted = false;
  });
}

function startEndWatch() {
  const threshold = params.end - FREEZE_LEAD_SECONDS;
  function tick() {
    if (!player || typeof player.getCurrentTime !== 'function') {
      endWatchHandle = requestAnimationFrame(tick);
      return;
    }
    if (player.getCurrentTime() >= threshold) {
      enterSting();
      return;
    }
    endWatchHandle = requestAnimationFrame(tick);
  }
  endWatchHandle = requestAnimationFrame(tick);
}

function stopEndWatch() {
  if (endWatchHandle !== null) {
    cancelAnimationFrame(endWatchHandle);
    endWatchHandle = null;
  }
}

function enterSting() {
  stopEndWatch();

  // Order matters: start the audio and reveal the bar first, so the sting's
  // onset is what the eye/ear locks onto, and the 1-2 frame pause latency
  // is absorbed underneath the bar animation rather than felt as a beat.
  stingAudio.currentTime = 0;
  stingAudio.play().catch(() => {
    // If playback is blocked, fall back straight to the held state so the
    // picture/bar don't hang waiting on audio that will never fire "ended".
    enterHeld();
  });
  overlayEl.dataset.visible = 'true';
  setReveal(0);
  setBlink(false);

  player.pauseVideo();
  if (SNAP_TO_END_FRAME) {
    player.seekTo(params.end, true);
  }

  function tick() {
    const t = stingAudio.currentTime;

    const wipeProgress = (t - BAR_WIPE_START_SECONDS) / (BAR_WIPE_END_SECONDS - BAR_WIPE_START_SECONDS);
    setReveal(Math.min(1, Math.max(0, wipeProgress)));

    let blinkOn = false;
    for (const kf of BLINK_KEYFRAMES) {
      if (kf.t <= t) blinkOn = kf.on;
    }
    setBlink(blinkOn);

    barAnimHandle = requestAnimationFrame(tick);
  }
  barAnimHandle = requestAnimationFrame(tick);

  stingAudio.addEventListener('ended', enterHeld, { once: true });
}

function enterHeld() {
  inPlayback = false;
  if (barAnimHandle !== null) {
    cancelAnimationFrame(barAnimHandle);
    barAnimHandle = null;
  }
  setReveal(1);
  setBlink(BLINK_KEYFRAMES[BLINK_KEYFRAMES.length - 1].on);
}

function onGateClick() {
  gateEl.hidden = true;
  inPlayback = true;
  primeAudioForLaterPlayback();
  player.seekTo(params.start, true);
  player.playVideo();
  startEndWatch();
}

function onVisibilityChange() {
  // A backgrounded tab throttles requestAnimationFrame, so the end-watch
  // loop can overshoot the cut by an arbitrary amount. Pause rather than
  // risk missing it, and let the user resume from where they left off.
  if (document.hidden && inPlayback) {
    stopEndWatch();
    player.pauseVideo();
    stingAudio.pause();
  }
}

function onPlayerReady() {
  gateEl.hidden = false;
  gateEl.disabled = false;
}

function onPlayerError() {
  showError('That video is unavailable or cannot be embedded.');
}

function createPlayer() {
  player = new YT.Player('player', {
    width: '800',
    height: '450',
    videoId: params.videoId,
    playerVars: {
      autoplay: 0,
      controls: 0,
      disablekb: 1,
      rel: 0,
      iv_load_policy: 3,
      cc_load_policy: 0,
      fs: 0,
      playsinline: 1,
      enablejsapi: 1,
      origin: window.location.origin,
    },
    events: {
      onReady: onPlayerReady,
      onError: onPlayerError,
    },
  });
}

function init() {
  const result = parseParams();
  if (result.error) {
    showError(result.error);
    return;
  }
  params = result;
  barLinkEl.href = params.url;

  gateEl.disabled = true;
  gateEl.addEventListener('click', onGateClick);
  document.addEventListener('visibilitychange', onVisibilityChange);

  if (window.YT && window.YT.Player) {
    createPlayer();
  } else {
    window.onYouTubeIframeAPIReady = createPlayer;
  }
}

init();
