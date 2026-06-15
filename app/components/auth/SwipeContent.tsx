export interface SwipeSlide {
  title: string;
  description: string;
  gif: string;
  gifDark: string;
  /**
   * One-play length of the GIF, in milliseconds. A GIF fires no "ended" event
   * and exposes no playback position, so LeftCarouselPanel can't know when a
   * clip finishes — it auto-advances on a timer of this length instead. Measure
   * it once from the source GIF (sum of its frame delays) and put it here. If
   * it's too short the slide flips before the clip reads as complete; too long
   * and the GIF visibly loops before advancing. Export the GIFs to loop
   * infinitely so that after a manual interaction the slide can keep playing.
   */
  durationMs: number;
  /**
   * Zoom/crop knob (percent), applied as a centre scale on the height-filled
   * clip. The baseline (0) fills the panel height, which crops the wide clip's
   * sides. Tune per slide since each clip frames its subject differently:
   *   • negative → zoom OUT: more of the sides stays contained in view (the
   *     clip no longer fills the height, so light letterboxing appears top and
   *     bottom). e.g. -15 shrinks it 15% from the current framing.
   *   • positive → zoom IN: crops more off the sides.
   */
  cropX: number;
}

// The .gifs are the animated version of the old PNG slides. They are wide,
// center-framed clips (the subject sits in the middle with empty margins),
// so LeftCarouselPanel centers them and lets the sides crop — unlike the old
// PNGs, which were tall compositions nudged upward.
//
// durationMs below is a placeholder: replace each with the real one-play length
// of its GIF (see the field doc above), otherwise auto-advance timing is off.
//
// Dark mode currently reuses the light GIF: the design team will supply
// dedicated dark clips later, at which point gifDark gets its own file.
export const SWIPE_CONTENT: SwipeSlide[] = [
  {
    title: "Distributed Storage",
    description:
      "A global network of independent nodes. Your files stay safe and accessible even if part of the network goes offline.",
    gif: "/assets/signin/1-light.gif",
    gifDark: "/assets/signin/1-dark.gif",
    durationMs: 9333,
    cropX: 0,
  },
  {
    title: "Confidential Computing",
    description:
      "Hardware-encrypted virtual machines. Not even the host can read your code or your data.",
    gif: "/assets/signin/2-light.gif",
    gifDark: "/assets/signin/2-dark.gif",
    durationMs: 7100,
    cropX: -25,
  },
  {
    title: "Bridge & Staking",
    description:
      "Stake your tokens and earn as the Hippius network grows. Transparent, non-custodial, on-chain.",
    gif: "/assets/signin/3-light.gif",
    gifDark: "/assets/signin/3-dark.gif",
    durationMs: 8949,
    cropX: -25,
  },
  {
    title: "Referrals",
    description:
      "Invite friends and earn credits every time they use Hippius. Credits apply directly to your storage and compute.",
    gif: "/assets/signin/4-light.gif",
    gifDark: "/assets/signin/4-dark.gif",
    durationMs: 7100,
    cropX: -10,
  },
];
