// The lock cue's device setting and its sound and vibration. The sound is off by default and kept on this device only
// (localStorage), not in the tray or the account (spec "Sound setting").
const SOUND_KEY = "prizecheck:scanner:lock-sound";

export function readLockSound(
  storage: Pick<Storage, "getItem"> | null = safeStorage()
): boolean {
  try {
    return storage?.getItem(SOUND_KEY) === "on";
  } catch {
    return false;
  }
}

export function writeLockSound(
  on: boolean,
  storage: Pick<Storage, "setItem" | "removeItem"> | null = safeStorage()
): void {
  try {
    if (on) storage?.setItem(SOUND_KEY, "on");
    else storage?.removeItem(SOUND_KEY);
  } catch {
    // The setting is best effort.
  }
}

function safeStorage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

let audio: AudioContext | null = null;

/** A short tick. An iPhone tab has no vibration API, so with the sound off its lock is silent and still. */
export function playLockCue(
  soundOn: boolean,
  nav: Pick<Navigator, "vibrate"> | undefined = typeof navigator === "undefined"
    ? undefined
    : navigator
): void {
  try {
    if (typeof nav?.vibrate === "function") nav.vibrate(30);
  } catch {
    // no vibration here
  }
  if (!soundOn) return;
  try {
    audio ??= new AudioContext();
    if (audio.state === "suspended") void audio.resume();
    const osc = audio.createOscillator();
    const gain = audio.createGain();
    osc.frequency.value = 880;
    gain.gain.setValueAtTime(0.12, audio.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, audio.currentTime + 0.12);
    osc.connect(gain).connect(audio.destination);
    osc.start();
    osc.stop(audio.currentTime + 0.12);
  } catch {
    // no audio here
  }
}
