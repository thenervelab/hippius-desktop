import {
  GlobalReliability,
  SecureFilesWithBlockChain,
  SmartAffordableStorage,
  EarnWithRefferals,
} from "../ui/icons";
import CircularShield from "../ui/icons/CircularShield";

export const SWIPE_CONTENT = [
  {
    heading: "Transparent, Decentralized, Cloud Storage",
    text: "Global Reliability",
    subText:
      "Powered by a decentralized network of hardware providers, not a single point of failure.",
    icon: <GlobalReliability className="xl:h-[270px] h-[160px] w-full" />,
  },
  {
    heading: "Secure Your Files with Blockchain",
    text: "Track Every File with CID",
    subText:
      "Your files are stored securely on our decentralized blockchain, with CID tracking ensuring traceability and preventing unauthorized access",

    icon: (
      <SecureFilesWithBlockChain className="xl:h-[270px] h-[160px] w-full" />
    ),
  },
  {
    heading: "Smart Affordable Storage",
    text: "Pay Only for What You Use",
    subText:
      "Store your data with cost-effective rates and no hidden fees, powered by transparent blockchain technology",
    icon: <SmartAffordableStorage className="xl:h-[270px] h-[160px] w-full" />,
  },
  {
    heading: "Earn Continuously with Referrals",
    text: "Share Your Unique Code",
    subText:
      "Generate a unique referral code and share it with anyone—earn ongoing rewards based on referred users’ usage, all tracked on the blockchain",
    icon: <EarnWithRefferals className="xl:h-[270px] h-[160px] w-full" />,
  },
  {
    heading: "Your Secret Phrase: The Key to Your Account",
    text: "Simple, Secure, Fully Yours",
    subText:
      "No third-party logins here! Your unique word phrase (mnemonic) unlocks a decentralized world. We don’t store it, so keep it safe and take full control.",
    icon: (
      <CircularShield className="xl:size-[270px] size-[160px] text-primary-80" />
    ),
  },
];
