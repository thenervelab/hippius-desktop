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
    image: "/assets/signin/1.png",
    imageDark: "/assets/signin/1-dark.png",
  },
  {
    title: "Confidential Computing",
    description:
      "Hardware-encrypted virtual machines. Not even the host can read your code or your data.",
    image: "/assets/signin/2.png",
    imageDark: "/assets/signin/2-dark.png",
  },
  {
    title: "Bridge & Staking",
    description:
      "Stake your tokens and earn as the Hippius network grows. Transparent, non-custodial, on-chain.",
    image: "/assets/signin/3.png",
    imageDark: "/assets/signin/3-dark.png",
  },
  {
    title: "Referrals",
    description:
      "Invite friends and earn credits every time they use Hippius. Credits apply directly to your storage and compute.",
    image: "/assets/signin/4.png",
    imageDark: "/assets/signin/4-dark.png",
  },
];
