export type BadgeVariant = "primary" | "coming-soon";

export interface OnboardingBadge {
  text: string;
  variant: BadgeVariant;
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
  nextLabel: string;
}

export const ONBOARDING_SCREENS: OnboardingScreen[] = [
  {
    id: 1,
    badges: [{ text: "Get Started", variant: "primary" }],
    heading: "Welcome to Hippius",
    subtitle:
      "Your personal cloud — encrypted, decentralized, and fully under your control.",
    featureLink:
      "Your files leave your device as ciphertext — only you can read them",
    body: "Hippius syncs your folders to a global network of independent nodes. No single company stores your data, and no one but you holds the keys.",
    pills: [],
    previewImage: "/assets/onboarding/home.png",
    nextLabel: "Get Started",
  },
  {
    id: 2,
    badges: [{ text: "Credits & Billing", variant: "primary" }],
    heading: "Pay for what you use. Nothing more.",
    subtitle:
      "Top up once and let Hippius handle the rest — billed by the block, not the month.",
    featureLink:
      "Run out of credits? Your files stay safe — sync simply pauses",
    body: "Storage costs $0.003 per GB per month, charged every 6 seconds. Top up anytime via Stripe or TAO, or pick a subscription plan that fits your usage.",
    pills: [
      "1 credit = $1",
      "Pay with Stripe or TAO",
      "Monthly plans available",
      "Free downloads always",
    ],
    previewImage: "/assets/onboarding/home.png",
    nextLabel: "Next",
  },
  {
    id: 3,
    badges: [
      { text: "Files & Actions", variant: "primary" },
      { text: "Coming Soon", variant: "coming-soon" },
    ],
    heading: "Your files, fully in your hands",
    subtitle: "Browse, preview, and manage everything from one place.",
    featureLink:
      "Right-click any file to see everything you can do with it",
    body: "Preview images, videos, and PDFs directly in the app. Download, reveal in Finder, or track any file live on the Hipstats explorer.",
    pills: [
      "Track any file on-chain",
      "Open from any device",
      "Every action, one click",
    ],
    previewImage: "/assets/onboarding/multi-folder-sync.png",
    nextLabel: "Next",
  },
  {
    id: 4,
    badges: [{ text: "Unlock Password", variant: "primary" }],
    heading: "One password. Desktop, web, everywhere.",
    subtitle:
      "Set it once — it works across all your devices and the web console.",
    featureLink:
      "Need to open a file on console.hippius.com? This is the password",
    body: "Your unlock password encrypts files locally and lets you access them on new devices. Without it, your encrypted files cannot be opened — not even by Hippius.",
    pills: [
      "Encrypts files locally",
      "Works on new devices",
      "Unlocks web console",
      "Not stored by Hippius",
    ],
    previewImage: "/assets/onboarding/recovery-phrase.png",
    nextLabel: "Next",
  },
  {
    id: 5,
    badges: [
      { text: "Recovery Phrase", variant: "primary" },
      { text: "Coming Soon", variant: "coming-soon" },
    ],
    heading: "Your phrase is your master key",
    subtitle:
      "This 12-word phrase is the only way to recover your account.",
    featureLink:
      "Lose your phrase and your files are gone — no exceptions",
    body: "Write it down on paper. Store it somewhere offline and secure. Never share it — not even with Hippius support. Keep copies in at least two different locations.",
    pills: [
      "Only you hold the keys",
      "Zero-knowledge encryption",
      "True data ownership",
    ],
    previewImage: "/assets/onboarding/recovery-phrase.png",
    nextLabel: "Sign In",
  },
];
