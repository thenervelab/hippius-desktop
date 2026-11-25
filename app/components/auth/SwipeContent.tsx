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

// Slides 1 to 4 are drawn in docs/plans/signin-visuals/scenes.html and
// rendered to GIFs there (the referral clip came from design). Each drawn clip
// loops in exactly 8 seconds (240 frames at 30 fps), so durationMs is exact.
// The clips are wide and center-framed, so LeftCarouselPanel centers them and
// lets the sides crop.
//
// Every slide has its own light and dark clip, each on the panel's flat
// background colour (#fffdff light, #161416 dark; see LeftCarouselPanel).

/**
 * Share & Track stays off the sign-in screen until document links are live on
 * every app. Its clips are kept in docs/plans/signin-visuals/clips/ rather
 * than public/, so the app does not ship them while the slide is hidden. To
 * bring it back, set this to true and move 4-light.gif and 4-dark.gif from
 * that folder into public/assets/signin/ (swipeContent.test.ts fails until
 * both are done).
 */
export const SHARE_TRACK_SLIDE_ENABLED = false;

export const SHARE_TRACK_SLIDE: SwipeSlide = {
  title: "Share & Track",
  description:
    "Share a file or folder by link and see who opened it, with comments and an optional NDA.",
  gif: "/assets/signin/4-light.gif",
  gifDark: "/assets/signin/4-dark.gif",
  durationMs: 8000,
  cropX: -6,
};

export const SWIPE_CONTENT: SwipeSlide[] = [
  {
    title: "Distributed Storage",
    description:
      "A global network of independent nodes. Your files stay safe and accessible even if part of the network goes offline.",
    gif: "/assets/signin/1-light.gif",
    gifDark: "/assets/signin/1-dark.gif",
    durationMs: 8000,
    cropX: 0,
  },
  {
    title: "Encrypted on Your Device",
    description:
      "Your files are encrypted before they leave your computer. Only you can open them.",
    gif: "/assets/signin/2-light.gif",
    gifDark: "/assets/signin/2-dark.gif",
    durationMs: 8000,
    cropX: 0,
  },
  {
    title: "Screen Recording",
    description: "Hit record, talk it through, and send the link.",
    gif: "/assets/signin/3-light.gif",
    gifDark: "/assets/signin/3-dark.gif",
    durationMs: 8000,
    cropX: 0,
  },
  ...(SHARE_TRACK_SLIDE_ENABLED ? [SHARE_TRACK_SLIDE] : []),
  {
    title: "Referrals",
    description:
      "Invite friends and earn Account Balance every time they use Hippius. Your balance goes straight toward your storage.",
    gif: "/assets/signin/5-light.gif",
    gifDark: "/assets/signin/5-dark.gif",
    durationMs: 7100,
    cropX: -10,
  },
];
