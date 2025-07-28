export const ONBOARDING_SCREENS = [
  {
    id: 1,
    titleText: "Welcome to Hippius",
    description:
      "Hippius is a secure, blockchain-powered platform for file storage, management, and collaboration.",
    screentTitleText: "Get Started",
    imagePath: "/assets/onboarding/home.png",
    imageMarginBottom: "mb-[75px]",
    imageClassName: " pl-4"
  },
  {
    id: 2,
    titleText: "Your Files. Fully Secured. Always Accessible.",
    description:
      "Upload, organize, and share your files effortlessly. With blockchain‑backed security, your data stays safe, synced, and always within reach.",
    screentTitleText: "File Hosting & Management",
    bulletPoints: ["Reliable IPFS Storage", "Efficient S3 Storage"],
    imagePath: "/assets/onboarding/files.png",
    imageMarginBottom: "mb-[75px]",
    imageClassName: " px-4"
  },
  {
    id: 3,
    titleText: "Secure Your Access with a New Passcode",
    description:
      "Your passcode encrypts your access key and secures your data. You can change it anytime to stay in control and keep your account safe.",
    screentTitleText: "Change Passcode",
    bulletPoints: [
      "Decentralized Storage for Extra Security",
      "Powered by Bittensor"
    ],
    imagePath: "/assets/onboarding/passcode.png",
    imageMarginBottom: "mb-[75px]",
    imageClassName: " px-4"
  },
  {
    id: 4,
    titleText: "Collaborate Securely with Sub-Accounts",
    description:
      "Sub‑accounts let you assign upload and delete rights. They use their own seed, yet all files still belong to your main account. We’re currently using these sub‑accounts to upload files to S3 storage.",
    screentTitleText: "Manage Access with Sub‑Accounts",
    bulletPoints: [
      "Role Assignment to Sub Accounts",
      "Effective Management of Permissions"
    ],
    imagePath: "/assets/onboarding/subaccounts.png",
    imageMarginBottom: "mb-[75px]",
    imageClassName: " pl-4"
  },
  {
    id: 5,
    titleText: "Your Unique Key for Protecting Data Integrity and Access",
    description:
      "This encryption key is used to securely save and access your files. Keep it safe—only you can regenerate or use it.",
    screentTitleText: "Secure Your Files with Encryption",
    bulletPoints: ["Secure File Storage", "Encryption‑Backed Security"],
    imagePath: "/assets/onboarding/encryption-key.png",
    imageMarginBottom: "mb-[75px]",
    imageClassName: " px-4"
  }
];
