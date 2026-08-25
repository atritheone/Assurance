export type SoundEffectName =
  | "attritiondeath"
  | "destruction"
  | "enemybarrierdown"
  | "enemygatecapture"
  | "gameover"
  | "hit"
  | "miss"
  | "movement"
  | "newinventoryunit"
  | "placement"
  | "playerbarrierdown"
  | "playergatecapture"
  | "victory";

declare global {
  interface Window {
    __ASSURANCE_SOUND_BASE64__?: Partial<Record<SoundEffectName, string>>;
  }
}

const SOUND_FILES: Record<SoundEffectName, string> = {
  attritiondeath: "attritiondeath.wav",
  destruction: "destruction.wav",
  enemybarrierdown: "enemybarrierdown.wav",
  enemygatecapture: "enemygatecapture.wav",
  gameover: "gameover.wav",
  hit: "hit.wav",
  miss: "miss.wav",
  movement: "movement.wav",
  newinventoryunit: "newinventoryunit.wav",
  placement: "placement.wav",
  playerbarrierdown: "playerbarrierdown.wav",
  playergatecapture: "playergatecapture.wav",
  victory: "victory.wav"
};

const JITTERED_SOUNDS = new Set<SoundEffectName>(["destruction", "hit", "miss", "movement", "placement"]);
const MASTER_VOLUME_GAIN = 1.35;
const sourceCache = new Map<SoundEffectName, string>();
const pendingSounds = new Set<Promise<void>>();
let masterVolume = 0.4;
let muted = false;

export function setSoundVolume(volume: number): void {
  masterVolume = clamp(volume * MASTER_VOLUME_GAIN, 0, 1);
}

export function setSoundMuted(value: boolean): void {
  muted = value;
}

export function playSound(effect: SoundEffectName, delayMs = 0): Promise<void> {
  const sound = delayMs > 0 ? delay(delayMs).then(() => playSoundNow(effect)) : playSoundNow(effect);
  return trackPendingSound(sound);
}

export function playSoundSequence(effects: SoundEffectName[]): Promise<void> {
  return Promise.all(effects.map((effect, index) => playSound(effect, index * 45))).then(() => undefined);
}

export async function playSoundAfterCurrentEffects(effect: SoundEffectName, delayMs = 0): Promise<void> {
  while (pendingSounds.size > 0) {
    await Promise.allSettled([...pendingSounds]);
  }

  await playSound(effect, delayMs);
}

function playSoundNow(effect: SoundEffectName): Promise<void> {
  if (muted || masterVolume <= 0) {
    return Promise.resolve();
  }

  const audio = new Audio(getSoundSource(effect));
  audio.preload = "auto";
  audio.volume = getVolume(effect);
  audio.playbackRate = getPlaybackRate(effect);
  setPreservesPitch(audio, false);

  return new Promise((resolve) => {
    let settled = false;
    const settle = (): void => {
      if (settled) {
        return;
      }

      settled = true;
      audio.removeEventListener("ended", settle);
      audio.removeEventListener("error", settle);
      resolve();
    };

    audio.addEventListener("ended", settle);
    audio.addEventListener("error", settle);
    void audio.play().catch(() => {
      // Browsers may block audio until the player has interacted with the page.
      settle();
    });
  });
}

function trackPendingSound(sound: Promise<void>): Promise<void> {
  const tracked = sound.finally(() => {
    pendingSounds.delete(tracked);
  });
  pendingSounds.add(tracked);
  return tracked;
}

function delay(delayMs: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, delayMs));
}

function getSoundSource(effect: SoundEffectName): string {
  const cached = sourceCache.get(effect);
  if (cached) {
    return cached;
  }

  const base64 = window.__ASSURANCE_SOUND_BASE64__?.[effect]?.replace(/\s+/g, "");
  const source = base64 ? `data:audio/wav;base64,${base64}` : `./sound/${SOUND_FILES[effect]}`;
  sourceCache.set(effect, source);
  return source;
}

function getVolume(effect: SoundEffectName): number {
  const baseVolume = effect === "movement" || effect === "placement" ? 0.55 : 0.72;
  if (!JITTERED_SOUNDS.has(effect)) {
    return baseVolume * masterVolume;
  }

  return clamp(baseVolume * randomBetween(0.88, 1.06) * masterVolume, 0, 1);
}

function getPlaybackRate(effect: SoundEffectName): number {
  return JITTERED_SOUNDS.has(effect) ? randomBetween(0.94, 1.06) : 1;
}

function randomBetween(minimum: number, maximum: number): number {
  return minimum + Math.random() * (maximum - minimum);
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

function setPreservesPitch(audio: HTMLAudioElement, value: boolean): void {
  const audioWithPitch = audio as HTMLAudioElement & {
    preservesPitch?: boolean;
    mozPreservesPitch?: boolean;
    webkitPreservesPitch?: boolean;
  };
  audioWithPitch.preservesPitch = value;
  audioWithPitch.mozPreservesPitch = value;
  audioWithPitch.webkitPreservesPitch = value;
}
