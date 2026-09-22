/**
 * The chat notification chime: a short two-note tone synthesised with
 * WebAudio, so the app ships no audio asset and the sound is identical on
 * every platform. Rust decides WHEN it plays (`NotifyResult.playSound`:
 * the banner was shown and the "Sound" preference is on); this module only
 * knows HOW.
 *
 * Shape: two sine notes a fifth apart (E5 → B5), each ~75 ms with a fast
 * attack and an exponential release, peaking at `PEAK_GAIN` — well under
 * full scale so it sits below system alert volume. Total ≈ 150 ms.
 *
 * OS "Do not disturb" cannot be read from the webview or through Tauri's
 * notification plugin; when the OS suppresses the banner it does so after
 * Rust has already reported `shown`, so the chime follows the preference,
 * not the OS focus mode. Mute the "Sound" switch in chat Preferences to
 * silence it.
 */

/** Peak gain of the envelope; the linear amplitude, not dB. */
export const PEAK_GAIN = 0.18;
/** Length of each note in seconds. */
export const NOTE_SECONDS = 0.075;
/** The two notes, in Hz: E5 then B5. */
export const NOTES: readonly [number, number] = [659.25, 987.77];

/** The subset of `AudioContext` the chime uses; a seam for tests. */
export interface ChimeContext {
  readonly currentTime: number;
  readonly destination: AudioNode;
  readonly state: AudioContextState;
  createOscillator(): OscillatorNode;
  createGain(): GainNode;
  resume(): Promise<void>;
}

type ContextFactory = () => ChimeContext;

let shared: ChimeContext | null = null;

function defaultFactory(): ChimeContext {
  if (!shared) shared = new AudioContext();
  return shared;
}

/** Whether this runtime can synthesise audio at all (SSR and old webviews cannot). */
export function chimeSupported(): boolean {
  return typeof AudioContext !== "undefined";
}

/**
 * Play the chime once. Resolves when the notes are scheduled (not when they
 * finish). A missing `AudioContext` or a context that refuses to resume is
 * a silent no-op, never an error: a notification must not fail because a
 * sound did not.
 */
export async function playChime(
  factory: ContextFactory = defaultFactory,
): Promise<void> {
  if (factory === defaultFactory && !chimeSupported()) return;
  let ctx: ChimeContext;
  try {
    ctx = factory();
    // A context created before any user gesture starts suspended in some
    // webviews; resuming is allowed once the page has been interacted with.
    if (ctx.state === "suspended") await ctx.resume();
    if (ctx.state !== "running") return;
  } catch {
    return;
  }
  const start = ctx.currentTime + 0.005;
  NOTES.forEach((frequency, index) => {
    const at = start + index * NOTE_SECONDS;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "sine";
    osc.frequency.setValueAtTime(frequency, at);
    gain.gain.setValueAtTime(0.0001, at);
    gain.gain.exponentialRampToValueAtTime(PEAK_GAIN, at + 0.008);
    gain.gain.exponentialRampToValueAtTime(0.0001, at + NOTE_SECONDS);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(at);
    osc.stop(at + NOTE_SECONDS + 0.01);
  });
}
