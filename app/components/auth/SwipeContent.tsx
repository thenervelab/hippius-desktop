export interface SwipeSlide {
  title: string;
  description: string;
  video: string;
  videoDark: string;
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

// The .mp4s are the animated version of the old PNG slides. They are wide,
// center-framed clips (the subject sits in the middle with empty margins),
// so LeftCarouselPanel centers them and lets the sides crop — unlike the old
// PNGs, which were tall compositions nudged upward.
//
// Dark mode currently reuses the light video: the design team will supply
// dedicated dark clips later, at which point videoDark gets its own file.
export const SWIPE_CONTENT: SwipeSlide[] = [
  {
    title: "Decentralized Storage",
    description:
      "A global network of independent nodes. Your files stay safe and accessible even if part of the network goes offline.",
    video: "/assets/signin/1-light.mp4",
    videoDark: "/assets/signin/1-dark.mp4",
    cropX: 0,
  },
  {
    title: "Confidential Computing",
    description:
      "Hardware-encrypted virtual machines. Not even the host can read your code or your data.",
    video: "/assets/signin/2-light.mp4",
    videoDark: "/assets/signin/2-dark.mp4",
    cropX: -25,
  },
  {
    title: "Bridge & Staking",
    description:
      "Stake your tokens and earn as the Hippius network grows. Transparent, non-custodial, on-chain.",
    video: "/assets/signin/3-light.mp4",
    videoDark: "/assets/signin/3-dark.mp4",
    cropX: -20,
  },
  {
    title: "Referrals",
    description:
      "Invite friends and earn credits every time they use Hippius. Credits apply directly to your storage and compute.",
    video: "/assets/signin/4-light.mp4",
    videoDark: "/assets/signin/4-dark.mp4",
    cropX: 0,
  },
];
