// Real pixel dimensions of the bar image assets (frames/bar-*.jpg). Exposed
// to CSS as custom properties so .bar-stack's aspect-ratio stays derived
// from one source instead of a second hardcoded literal.
export const BAR_IMAGE_WIDTH_PX = 1920;
export const BAR_IMAGE_HEIGHT_PX = 171;

// Left-to-right reveal of the "full" bar over "blank", in seconds from the
// start of the sting audio, roughly synced to the words being spoken. Ends
// before the blink/flicker phase below, which is a separate flash effect
// tied to the audio's loudness peak rather than to speech.
export const BAR_WIPE_START_SECONDS = 0.00;
export const BAR_WIPE_END_SECONDS = 0.70;

// Blink schedule: whether the blue flash bar is shown, once the reveal above
// has finished. Derived from the sting's actual loudness envelope (loudest
// block ~0.75-1.15s). Tune these against the audio by ear/eye — nothing else
// depends on their values.
export const BLINK_KEYFRAMES = [
  { t: 0.74, on: true },
  { t: 0.86, on: false },
  { t: 0.96, on: true },
  { t: 1.06, on: false },
  { t: 1.12, on: true },
];

// How long before the nominal end position to trigger the freeze, to absorb
// the postMessage/pauseVideo round-trip latency to the iframe.
export const FREEZE_LEAD_SECONDS = 0.06;

// After pausing, seek back to the exact end position so the frozen frame is
// deterministic regardless of how much the pause itself overshot.
export const SNAP_TO_END_FRAME = true;

// playerVars shared by every stage on the site (the real player and the
// create page's preview): a plain embed with no YouTube-owned chrome, since
// the .shield above the iframe only stops clicks — the chrome itself must
// never be enabled in the first place.
export function stagePlayerVars() {
  return {
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
  };
}

export function applyBarImageVars(rootEl = document.documentElement) {
  rootEl.style.setProperty('--bar-image-width', BAR_IMAGE_WIDTH_PX);
  rootEl.style.setProperty('--bar-image-height', BAR_IMAGE_HEIGHT_PX);
}

// Builds the bar-wipe + sting-audio + blink sequence for one stage. `player`
// must already exist (a YT.Player instance) — pass it in after creation,
// not a getter, since the instance itself is never replaced for the life of
// a stage (a video swap uses cueVideoById/loadVideoById on the same player).
export function createStingSequence({ player, overlayEl, audioEl }) {
  let endWatchHandle = null;
  let barAnimHandle = null;
  let onHeld = null;

  function setReveal(fraction) {
    overlayEl.style.setProperty('--reveal', `${fraction * 100}%`);
    // "MORE" only becomes clickable once it's fully wiped in; never reset
    // back to non-clickable afterwards (the reveal only ever runs forward
    // once per sting).
    if (fraction >= 1) {
      overlayEl.dataset.clickable = 'true';
    }
  }

  function setBlink(on) {
    overlayEl.dataset.blink = on ? 'on' : 'off';
  }

  function primeAudioForLaterPlayback() {
    // Must happen inside the user gesture (the gate/preview click) so a
    // later, programmatic play() during the sting isn't blocked by autoplay
    // policies. Muted rather than volume-zeroed: iOS Safari ignores
    // HTMLMediaElement.volume.
    audioEl.muted = true;
    audioEl.play().then(() => {
      audioEl.pause();
      audioEl.currentTime = 0;
      audioEl.muted = false;
    }).catch(() => {
      // Some browsers may still reject this priming play; the later real
      // play() call at sting time is still attempted regardless.
      audioEl.muted = false;
    });
  }

  function stopEndWatch() {
    if (endWatchHandle !== null) {
      cancelAnimationFrame(endWatchHandle);
      endWatchHandle = null;
    }
  }

  function stopBarAnim() {
    if (barAnimHandle !== null) {
      cancelAnimationFrame(barAnimHandle);
      barAnimHandle = null;
    }
  }

  function startEndWatch(end) {
    const threshold = end - FREEZE_LEAD_SECONDS;
    // A fresh seekTo(from) is an async postMessage to the iframe — on the
    // very next frame, getCurrentTime() can still report the *old* position
    // (e.g. sitting at a previous sting's frozen "end" frame), which would
    // read as already past the threshold and fire the sting instantly. Don't
    // trust the threshold until we've actually observed playback below it.
    let armed = false;
    function tick() {
      if (!player || typeof player.getCurrentTime !== 'function') {
        endWatchHandle = requestAnimationFrame(tick);
        return;
      }
      const t = player.getCurrentTime();
      if (!armed) {
        if (t < threshold) armed = true;
        endWatchHandle = requestAnimationFrame(tick);
        return;
      }
      if (t >= threshold) {
        enterSting(end);
        return;
      }
      endWatchHandle = requestAnimationFrame(tick);
    }
    endWatchHandle = requestAnimationFrame(tick);
  }

  function enterSting(end) {
    stopEndWatch();

    // Order matters — do not reorder: start the audio and reveal the bar
    // first, so the sting's onset is what the eye/ear locks onto, and the
    // 1-2 frame pause latency is absorbed underneath the bar animation
    // rather than felt as a beat.
    audioEl.currentTime = 0;
    audioEl.play().catch(() => {
      // If playback is blocked, fall back straight to the held state so the
      // picture/bar don't hang waiting on audio that will never fire "ended".
      enterHeld();
    });
    overlayEl.dataset.visible = 'true';
    setReveal(0);
    setBlink(false);

    player.pauseVideo();
    if (SNAP_TO_END_FRAME) {
      player.seekTo(end, true);
    }

    function tick() {
      const t = audioEl.currentTime;

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

    audioEl.addEventListener('ended', enterHeld, { once: true });
  }

  function enterHeld() {
    stopBarAnim();
    setReveal(1);
    setBlink(BLINK_KEYFRAMES[BLINK_KEYFRAMES.length - 1].on);
    const callback = onHeld;
    onHeld = null;
    if (callback) callback();
  }

  function play({ from, end, onHeld: onHeldCallback } = {}) {
    onHeld = onHeldCallback || null;
    primeAudioForLaterPlayback();
    player.seekTo(from, true);
    player.playVideo();
    startEndWatch(end);
  }

  // Cancels any in-flight watch/sting without touching the overlay's visual
  // state — used when playback is interrupted (e.g. tab backgrounded) but
  // should be resumable-looking.
  function stop() {
    stopEndWatch();
    stopBarAnim();
    // {once: true} only deregisters itself once the event actually fires;
    // if we stop mid-sting it's still armed and would fire ~1s later on a
    // reused audio element (e.g. the create page interrupting a preview).
    audioEl.removeEventListener('ended', enterHeld);
    player.pauseVideo();
    audioEl.pause();
    onHeld = null;
  }

  // stop() plus clearing the overlay back to its pre-sting appearance —
  // used when re-arming for another preview on the same stage.
  function reset() {
    stop();
    delete overlayEl.dataset.visible;
    delete overlayEl.dataset.clickable;
    setBlink(false);
    overlayEl.style.setProperty('--reveal', '0%');
  }

  return { play, stop, reset };
}

// How long before the clip's natural end to start fading its volume down,
// to smooth over background.mp3's abrupt cut rather than exposing it.
export const HOVER_AUDIO_END_FADE_SECONDS = 1;

// How long a quick fade-out takes when the pointer leaves early, before
// pausing and resetting back to the start for the next hover.
export const HOVER_AUDIO_LEAVE_FADE_MS = 250;

// Plays `audioEl` from the start for as long as the pointer hovers `linkEl`,
// fading its volume down over the last HOVER_AUDIO_END_FADE_SECONDS to
// smooth its abrupt ending, and fading out quickly + resetting to the start
// if the pointer leaves early. Relies on `linkEl` only dispatching pointer
// events while it's actually interactive — the "MORE" link is
// `pointer-events: none` until data-clickable is set — so no extra
// state-checking is needed here.
export function bindHoverBackgroundAudio(linkEl, audioEl, {
  endFadeSeconds = HOVER_AUDIO_END_FADE_SECONDS,
  leaveFadeMs = HOVER_AUDIO_LEAVE_FADE_MS,
} = {}) {
  let animHandle = null;

  function stopAnim() {
    if (animHandle !== null) {
      cancelAnimationFrame(animHandle);
      animHandle = null;
    }
  }

  function resetAudio() {
    stopAnim();
    audioEl.pause();
    audioEl.currentTime = 0;
    audioEl.volume = 1;
  }

  function tickEndFade() {
    const { currentTime, duration } = audioEl;
    if (Number.isFinite(duration) && duration > 0) {
      const remaining = duration - currentTime;
      const fraction = remaining <= endFadeSeconds ? remaining / endFadeSeconds : 1;
      // volume throws (rather than clamping) outside [0, 1] — floating-point
      // slop right at the fade boundary is enough to trip that.
      audioEl.volume = Math.min(1, Math.max(0, fraction));
    }
    if (!audioEl.paused && !audioEl.ended) {
      animHandle = requestAnimationFrame(tickEndFade);
    }
  }

  function onEnter() {
    stopAnim();
    audioEl.currentTime = 0;
    audioEl.volume = 1;
    // Hover isn't always treated as a user gesture by autoplay policy; if
    // playback is blocked there's nothing else to do here — no audio, but
    // nothing else breaks either.
    audioEl.play().catch(() => {});
    animHandle = requestAnimationFrame(tickEndFade);
  }

  function onLeave() {
    stopAnim();
    const startVolume = audioEl.volume;
    const startTime = performance.now();
    function tickLeaveFade(now) {
      // Clamp both ends: a rAF timestamp can (rarely) land a hair before the
      // performance.now() sampled synchronously above, going negative —
      // volume throws (rather than clamping) outside [0, 1], which would
      // otherwise kill this rAF chain before it ever reaches resetAudio().
      const progress = Math.min(1, Math.max(0, (now - startTime) / leaveFadeMs));
      audioEl.volume = Math.min(1, Math.max(0, startVolume * (1 - progress)));
      if (progress < 1) {
        animHandle = requestAnimationFrame(tickLeaveFade);
      } else {
        resetAudio();
      }
    }
    animHandle = requestAnimationFrame(tickLeaveFade);
  }

  linkEl.addEventListener('pointerenter', onEnter);
  linkEl.addEventListener('pointerleave', onLeave);
}
