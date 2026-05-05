export interface SwipeSlide {
  title: string;
  description: string;
  image: string;
  imageDark: string;
}

export const SWIPE_CONTENT: SwipeSlide[] = [
  {
    title: "Decentralized Storage",
    description:
      "A global network of independent nodes. Your files stay safe and accessible even if part of the network goes offline.",
    image: "/assets/signup/1.png",
    imageDark: "/assets/signup/1-dark.png",
  },
  {
    title: "Confidential Computing",
    description:
      "Hardware-encrypted virtual machines. Not even the host can read your code or your data.",
    image: "/assets/signup/2.png",
    imageDark: "/assets/signup/2-dark.png",
  },
  {
    title: "Bridge & Staking",
    description:
      "Stake your tokens and earn as the Hippius network grows. Transparent, non-custodial, on-chain.",
    image: "/assets/signup/3.png",
    imageDark: "/assets/signup/3-dark.png",
  },
  {
    title: "Referrals",
    description:
      "Invite friends and earn credits every time they use Hippius. Credits apply directly to your storage and compute.",
    image: "/assets/signup/4.png",
    imageDark: "/assets/signup/4-dark.png",
  },
];
