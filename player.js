// Bar animation schedule, in seconds from the start of the sting audio.
// Derived from the sting's actual loudness envelope (loudest block ~0.75-1.15s).
// Tune these against the audio by ear/eye — nothing else depends on their values.
const BAR_KEYFRAMES = [
  { t: 0.00, frame: 'blank' },
  { t: 0.08, frame: 'full' },
  { t: 0.74, frame: 'blue' },
  { t: 0.86, frame: 'full' },
  { t: 0.96, frame: 'blue' },
  { t: 1.06, frame: 'full' },
];

// How long before the nominal end position to trigger the freeze, to absorb
// the postMessage/pauseVideo round-trip latency to the iframe.
const FREEZE_LEAD_SECONDS = 0.06;

// After pausing, seek back to the exact end position so the frozen frame is
// deterministic regardless of how much the pause itself overshot.
const SNAP_TO_END_FRAME = true;

const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;

const stageEl = document.getElementById('stage');
const overlayEl = document.getElementById('overlay');
const gateEl = document.getElementById('gate');
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

function parseParams() {
  const search = new URLSearchParams(window.location.search);
  const v = search.get('v');
  const start = Number(search.get('start'));
  const end = Number(search.get('end'));

  if (!v || !VIDEO_ID_RE.test(v)) {
    return { error: 'Missing or invalid "v" parameter: expected an 11-character YouTube video ID.' };
  }
  if (!Number.isFinite(start) || start < 0) {
    return { error: 'Missing or invalid "start" parameter: expected a number of seconds >= 0.' };
  }
  if (!Number.isFinite(end) || end <= start) {
    return { error: 'Missing or invalid "end" parameter: expected a number of seconds greater than "start".' };
  }

  return { videoId: v, start, end };
}

function setBarFrame(frame) {
  overlayEl.dataset.frame = frame;
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
  setBarFrame('blank');

  player.pauseVideo();
  if (SNAP_TO_END_FRAME) {
    player.seekTo(params.end, true);
  }

  function tick() {
    const t = stingAudio.currentTime;
    let frame = BAR_KEYFRAMES[0].frame;
    for (const kf of BAR_KEYFRAMES) {
      if (kf.t <= t) frame = kf.frame;
    }
    setBarFrame(frame);
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
  setBarFrame(BAR_KEYFRAMES[BAR_KEYFRAMES.length - 1].frame);
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
