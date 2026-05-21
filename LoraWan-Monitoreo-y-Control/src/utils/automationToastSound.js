/** @type {HTMLAudioElement | null} */
let bellAudio = null;
/** @type {string | null} */
let bellBlobUrl = null;
/** @type {AudioContext | null} */
let sharedCtx = null;
let audioPrimed = false;
let pendingBell = false;

function getAudioContext() {
  if (typeof window === 'undefined') return null;
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx) return null;
  if (!sharedCtx) sharedCtx = new Ctx();
  return sharedCtx;
}

/** Genera un WAV corto (campanita) en memoria. */
function buildBellWavBlob() {
  const sampleRate = 22050;
  const durationSec = 1.15;
  const numSamples = Math.floor(sampleRate * durationSec);
  const dataSize = numSamples * 2;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  const writeStr = (off, s) => {
    for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i));
  };

  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeStr(36, 'data');
  view.setUint32(40, dataSize, true);

  for (let i = 0; i < numSamples; i++) {
    const t = i / sampleRate;
    const attack = 1 - Math.exp(-t * 35);
    const decay = Math.exp(-t * 3.8);
    const env = attack * decay;
    const tone =
      Math.sin(2 * Math.PI * 880 * t) * 0.5 +
      Math.sin(2 * Math.PI * 1318.51 * t) * 0.28 +
      Math.sin(2 * Math.PI * 1760 * t) * 0.14 +
      Math.sin(2 * Math.PI * 2217 * t) * 0.06;
    const sample = Math.max(-1, Math.min(1, tone * env * 0.92));
    view.setInt16(44 + i * 2, Math.floor(sample * 32000), true);
  }

  return new Blob([buffer], { type: 'audio/wav' });
}

function ensureBellAudio() {
  if (typeof window === 'undefined') return null;
  if (!bellAudio) {
    if (!bellBlobUrl) bellBlobUrl = URL.createObjectURL(buildBellWavBlob());
    bellAudio = new Audio(bellBlobUrl);
    bellAudio.preload = 'auto';
    bellAudio.volume = 0.65;
  }
  return bellAudio;
}

function playWebAudioBell() {
  const ctx = getAudioContext();
  if (!ctx) return Promise.reject(new Error('no ctx'));
  const run = () => {
    const now = ctx.currentTime;
    const master = ctx.createGain();
    master.gain.setValueAtTime(0.001, now);
    master.gain.exponentialRampToValueAtTime(0.38, now + 0.02);
    master.gain.exponentialRampToValueAtTime(0.001, now + 1.35);
    master.connect(ctx.destination);

    const partials = [
      { f: 880, g: 1 },
      { f: 1318.5, g: 0.5 },
      { f: 1760, g: 0.3 },
    ];
    for (const { f, g } of partials) {
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = f;
      const gn = ctx.createGain();
      gn.gain.setValueAtTime(0.22 * g, now);
      gn.gain.exponentialRampToValueAtTime(0.001, now + 1.2);
      osc.connect(gn);
      gn.connect(master);
      osc.start(now);
      osc.stop(now + 1.3);
    }
  };
  if (ctx.state === 'suspended') return ctx.resume().then(run);
  run();
  return Promise.resolve();
}

/**
 * Tras el primer gesto del usuario, «desbloquea» el elemento Audio (política autoplay).
 */
export function unlockAutomationToastAudio() {
  if (typeof window === 'undefined') return;
  const audio = ensureBellAudio();
  const ctx = getAudioContext();
  if (ctx && ctx.state === 'suspended') void ctx.resume().catch(() => {});

  if (!audio || audioPrimed) {
    if (pendingBell) {
      pendingBell = false;
      void playAutomationToastBell();
    }
    return;
  }

  audio.volume = 0.01;
  const p = audio.play();
  if (!p) {
    audioPrimed = true;
    return;
  }
  p.then(() => {
    audio.pause();
    audio.currentTime = 0;
    audio.volume = 0.65;
    audioPrimed = true;
    if (pendingBell) {
      pendingBell = false;
      void playAutomationToastBell();
    }
  }).catch(() => {
    audioPrimed = true;
    void playWebAudioBell().catch(() => {});
  });
}

/**
 * Registra listeners globales para desbloquear audio al usar la app.
 * Llamar una vez al montar la raíz (App).
 */
export function installAutomationToastAudioUnlock() {
  if (typeof window === 'undefined' || window.__SYSCOM_TOAST_AUDIO_UNLOCK__) return;
  window.__SYSCOM_TOAST_AUDIO_UNLOCK__ = true;

  const onGesture = () => unlockAutomationToastAudio();

  for (const ev of ['pointerdown', 'click', 'touchstart', 'keydown']) {
    window.addEventListener(ev, onGesture, { capture: true, passive: true });
  }

  ensureBellAudio();
}

/**
 * Campanita al mostrar alertas de automatización.
 */
export function playAutomationToastBell() {
  if (typeof window === 'undefined') return Promise.resolve();

  const audio = ensureBellAudio();
  const tryHtmlAudio = () => {
    if (!audio) return Promise.reject(new Error('no audio'));
    audio.volume = 0.65;
    audio.currentTime = 0;
    return audio.play();
  };

  const attempt = () =>
    tryHtmlAudio().catch(() => playWebAudioBell()).catch(() => {
      pendingBell = true;
    });

  if (!audioPrimed) {
    pendingBell = true;
    unlockAutomationToastAudio();
  }

  return attempt();
}
