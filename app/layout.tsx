import { Geist } from "next/font/google";
import localFont from "next/font/local";
import "@/app/globals.css";
import Providers from "@/components/providers";
import { Toaster } from "sonner";
import "react-circular-progressbar/dist/styles.css";
import NextTopLoader from "nextjs-toploader";
import { WalletAuthProvider } from "./lib/wallet-auth-context";
import { metadata as appMetadata } from "./metadata";
// import SplashWrapper from "./components/splash-screen";

export const metadata = appMetadata;

const digitalFonts = localFont({
  src: "./fonts/DigitalNumbers-Regular.ttf",
  display: "swap",
});

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

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
        <Providers>
          <WalletAuthProvider>
            <NextTopLoader color="#3167DD" showSpinner={false} />
            <div className="flex min-h-screen h-screen">{children}</div>
            {/* <SplashWrapper skipSplash={false}>
          </SplashWrapper> */}
            <Toaster />
          </WalletAuthProvider>
        </Providers>
      </body>
    </html>
  );
}
