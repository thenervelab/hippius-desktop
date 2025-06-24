import type { Metadata } from "next";
import { Geist } from "next/font/google";
import localFont from "next/font/local";
import "@/app/globals.css";
import Sidebar from "@/components/sidebar";
import RootFooter from "@/components/root-footer";
import Providers from "@/components/providers";
import { Toaster } from "sonner";
import "react-circular-progressbar/dist/styles.css";
import NextTopLoader from "nextjs-toploader";
import TrayInitialiser from "./components/tray-initialiser";

const digitalFonts = localFont({
  src: "./fonts/DigitalNumbers-Regular.ttf",
  display: "swap",
});

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

// Default metadata that will be used across the site
export const metadata: Metadata = {
  metadataBase: new URL("https://hipstats.com"),
  title: {
    default: "Hippius Explorer - Decentralized Storage Blockchain",
    template: "%s", // This allows pages to set just their part of the title
  },
  description:
    "Web3 decentralized storage blockchain, part of the Bittensor ecosystem. Track blocks, nodes, miners, and IPFS/S3 metrics in real time.",
  openGraph: {
    type: "website",
    siteName: "Hippius Explorer",
    title: {
      default: "Hippius Explorer - Decentralized Storage Blockchain",
      template: "%s",
    },
    description:
      "Web3 decentralized storage blockchain, part of the Bittensor ecosystem. Track blocks, nodes, miners, and IPFS/S3 metrics in real time.",
    url: "https://hipstats.com/",
    images: [
      {
        url: "https://hipstats.com/opengraph-image.png",
        width: 1200,
        height: 630,
        alt: "Hippius Explorer",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: {
      default: "Hippius Explorer - Decentralized Storage Blockchain",
      template: "%s",
    },
    description:
      "Web3 decentralized storage blockchain, part of the Bittensor ecosystem. Track blocks, nodes, miners, and IPFS/S3 metrics in real time.",
    images: ["https://hipstats.com/opengraph-image.png"],
    creator: "@hippiusstorage",
  },
};

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="scroll-smooth">
      <body
        className={`${digitalFonts.className} ${geistSans.className} ${geistSans.variable} bg-grey-100 text-grey-10 antialiased font-sans`}
      >
        <TrayInitialiser />
        <Providers>
          <NextTopLoader color="#3167DD" showSpinner={false} />
          <div className="flex min-h-screen">
            <Sidebar />
            <div className="flex flex-col flex-grow">
              <main className="flex-grow ml-[200px] p-6">{children}</main>
              <div className="ml-[200px]">
                <RootFooter />
              </div>
            </div>
          </div>
          <Toaster />
        </Providers>
      </body>
    </html>
  );
}
