import { describe, expect, it, vi } from "vitest";
import { playLockCue, readLockSound, writeLockSound } from "./sound";

function storage() {
  const data = new Map<string, string>();
  return {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    removeItem: (k: string) => void data.delete(k),
  };
}

describe("the lock sound setting", () => {
  it("is off by default", () => {
    expect(readLockSound(storage())).toBe(false);
    expect(readLockSound(null)).toBe(false);
  });

  it("is kept on the device once turned on, and off again", () => {
    const s = storage();
    writeLockSound(true, s);
    expect(readLockSound(s)).toBe(true);
    writeLockSound(false, s);
    expect(readLockSound(s)).toBe(false);
  });

  it("survives a storage that throws", () => {
    const broken = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
      removeItem: () => {
        throw new Error("blocked");
      },
    };
    expect(readLockSound(broken)).toBe(false);
    expect(() => writeLockSound(true, broken)).not.toThrow();
  });
});

describe("the lock cue", () => {
  it("vibrates where the browser can, and plays no sound with the setting off", () => {
    const vibrate = vi.fn();
    const audio = vi.fn();
    vi.stubGlobal("AudioContext", audio);
    playLockCue(false, { vibrate });
    expect(vibrate).toHaveBeenCalledOnce();
    expect(audio).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("is silent and still where there is no vibration", () => {
    expect(() => playLockCue(false, {} as Navigator)).not.toThrow();
  });
});
