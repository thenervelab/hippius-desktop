"use client";
import { Inter as InterFont, Geist, Geist_Mono } from "next/font/google";
import localFont from "next/font/local";
import "@/app/globals.css";
import "sonner/dist/styles.css";
import "react-circular-progressbar/dist/styles.css";
import AppShell from "@/app/components/AppShell";
import { cn } from "./lib/utils";
const inter = InterFont({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-inter",
});

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

const digitalFonts = localFont({
  src: "./fonts/DigitalNumbers-Regular.ttf",
  variable: "--font-digital",
  display: "swap",
});

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="scroll-smooth">
      <body
        className={cn(
          inter.variable,
          geistSans.variable,
          geistMono.variable,
          digitalFonts.variable,
          geistSans.className,
          "bg-grey-100 text-grey-10 antialiased font-geist",
        )}
      >
        {/* AppShell decides which provider tree to mount per window:
         *  the full app for the main window, or a minimal self-contained
         *  tree for the borderless system-tray popover (the `/tray-panel`
         *  route). See app/components/AppShell.tsx. */}
        <AppShell>{children}</AppShell>
      </body>
    </html>
  );
}
