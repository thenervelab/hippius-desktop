export interface OnboardingBadge {
  text: string;
}

export interface OnboardingScreen {
  id: number;
  badges: OnboardingBadge[];
  heading: string;
  subtitle: string;
  featureLink: string;
  body: string;
  pills: string[];
  previewImage: string;
  previewImageDark?: string;
  /** Left offset of the preview container (default "10%"). Use to align images that have no built-in left padding. */
  previewLeft?: string;
  nextLabel: string;
}

export const ONBOARDING_SCREENS: OnboardingScreen[] = [
  {
    id: 1,
    badges: [{ text: "Get Started" }],
    heading: "Welcome to Hippius",
    subtitle:
      "Your personal cloud, encrypted, decentralized, and fully under your control.",
    featureLink:
      "Your files are encrypted on your device before upload, only you can read them",
    body: "Hippius distributes your encrypted files across a global network of independent nodes. Your encryption keys never leave your device, so no one can read your files.",
    pills: [],
    previewImage: "/assets/onboarding/welcome-to-hippius.png",
    previewImageDark: "/assets/onboarding/welcome-to-hippius-dark.png",
    nextLabel: "Get Started",
    previewLeft: "0%",

  },
  {
    id: 2,
    badges: [{ text: "Credits & Billing" }],
    heading: "Pay for what you use. Nothing more.",
    subtitle:
      "Top up once and let Hippius handle the rest, billed by the block, not the month.",
    featureLink:
      "Run out of credits? Your files stay safe, sync simply pauses",
    body: "Storage costs $0.003 per GB per month, charged every 6 seconds. Top up anytime via Stripe or TAO, or pick a subscription plan that fits your usage.",
    pills: [
      "1 credit = $1",
      "Pay with Stripe or TAO",
      "Monthly plans available",
      "Free downloads always",
    ],
    previewImage: "/assets/onboarding/billing.png",
    previewImageDark: "/assets/onboarding/billing-dark.png",
    nextLabel: "Next",
    previewLeft: "0%",
  },
  {
    id: 3,
    badges: [{ text: "Files & Actions" }],
    heading: "Your files, fully in your hands",
    subtitle: "Browse, preview, and manage everything from one place.",
    featureLink: "Right click on any file to see everything you can do with it",
    body: "Preview images, videos, and PDFs directly in the app. Download, reveal in Finder, or track any file live on the Hipstats explorer.",
    pills: [
      "Track any file on-chain",
      "Open from any device",
      "Every action, one click",
    ],
    previewImage: "/assets/onboarding/files.png",
    previewImageDark: "/assets/onboarding/files-dark.png",
    previewLeft: "0%",
    nextLabel: "Next"
  },
  {
    id: 4,
    badges: [{ text: "Unlock Password" }],
    heading: "One password. Desktop, web, everywhere.",
    subtitle:
      "Set it once and it works across all your devices and the web console.",
    featureLink:
      "Need to open a file on console.hippius.com? This is the password",
    body: "Your unlock password encrypts files locally and lets you access them on new devices. Without it, your encrypted files cannot be opened, not even by Hippius.",
    pills: [
      "Encrypts files locally",
      "Works on new devices",
      "Unlocks web console",
      "Not stored by Hippius",
    ],
    previewImage: "/assets/onboarding/unlock-password.png",
    previewImageDark: "/assets/onboarding/unlock-password-dark.png",
    previewLeft: "-10%",
    nextLabel: "Next",
  },
  {
    id: 5,
    badges: [{ text: "Access Key" }],
    heading: "Your access key is your master key",
    subtitle: "This 12 word access key is the only way to recover your account.",
    featureLink: "Lose your access key and your files are gone, no exceptions",
    body: "Write it down on paper. Store it somewhere offline and secure. Never share it, not even with Hippius support. Keep copies in at least two different locations.",
    pills: [
      "Only you hold the keys",
      "Zero knowledge encryption",
      "True data ownership",
    ],
    previewImage: "/assets/onboarding/mnemonic-seed.png",
    previewImageDark: "/assets/onboarding/mnemonic-seed-dark.png",
    nextLabel: "Start Syncing",
  },
];
