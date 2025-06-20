import { Metadata } from "next";

export function createMetadata(
  title: string,
  description: string,
  keywords?: string
): Metadata {
  return {
    title,
    description,
    keywords,
    openGraph: {
      title,
      description,
      images: [
        {
          url: "opengraph-image.png",
          width: 1200,
          height: 630,
          alt: "Hippius Explorer",
        },
      ],
      type: "website",
    },
    twitter: {
      title,
      description,
      images: ["opengraph-image.png"],
    },
  };
}