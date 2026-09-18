import { parseClipParams } from './clip-url.js';
import { applyBarImageVars, stagePlayerVars, createStingSequence, bindHoverBackgroundAudio } from './sting.js';

const stageEl = document.getElementById('stage');
const overlayEl = document.getElementById('overlay');
const gateEl = document.getElementById('gate');
const barLinkEl = document.getElementById('bar-link');
const errorEl = document.getElementById('error');
const errorMessageEl = document.getElementById('error-message');
const welcomeEl = document.getElementById('welcome');
const stingAudio = document.getElementById('sting');
const backgroundAudio = document.getElementById('background');

bindHoverBackgroundAudio(barLinkEl, backgroundAudio);

let player = null;
let sequence = null;
let params = null;
let inPlayback = false; // true from gate click through to held state; used by the visibility guard

function showError(message) {
  stageEl.hidden = true;
  errorEl.hidden = false;
  errorMessageEl.textContent = message;
}

function showWelcome() {
  stageEl.hidden = true;
  welcomeEl.hidden = false;
}

function onGateClick() {
  gateEl.hidden = true;
  inPlayback = true;
  sequence.play({
    from: params.start,
    end: params.end,
    onHeld: () => { inPlayback = false; },
  });
}

function onVisibilityChange() {
  // A backgrounded tab throttles requestAnimationFrame, so the end-watch
  // loop can overshoot the cut by an arbitrary amount. Pause rather than
  // risk missing it, and let the user resume from where they left off.
  if (document.hidden && inPlayback) {
    sequence.stop();
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
    playerVars: stagePlayerVars(),
    events: {
      onReady: onPlayerReady,
      onError: onPlayerError,
    },
  });
  sequence = createStingSequence({ player, overlayEl, audioEl: stingAudio });
}

function init() {
  if (!window.location.search) {
    showWelcome();
    return;
  }

  const result = parseClipParams(new URLSearchParams(window.location.search));
  if (result.error) {
    showError(result.error);
    return;
  }
  params = result;
  barLinkEl.href = params.url;
  applyBarImageVars();

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
