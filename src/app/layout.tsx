import type { Metadata, Viewport } from "next";
import { Geist } from "next/font/google";
import "katex/dist/katex.min.css";
import "./globals.css";
import { ThemeScript } from "@/components/ThemeScript";
import { SITE_URL } from "@/lib/constants";

// Geist for UI sans (its metric-adjusted fallback keeps the UI clean even if
// the webfont can't be fetched). Prose serif and code mono use system font
// stacks (see globals.css) so they render crisply with no network dependency.
const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
  display: "swap",
});

const seoDescription =
  "ProperChat lets you chat with Claude, ChatGPT, and Gemini in one place. Branch any reply into Slack-style threads and switch models mid-conversation.";

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: {
    default: "ProperChat - one chat, every model, Slack-style threads",
    template: "%s · ProperChat",
  },
  description: seoDescription,
  keywords: [
    "ai chat",
    "multi-model chat",
    "claude chatgpt gemini",
    "threaded chat",
    "branch chat",
    "conversation tree",
  ],
  applicationName: "ProperChat",
  alternates: { canonical: "/" },
  openGraph: {
    type: "website",
    siteName: "ProperChat",
    title: "ProperChat - one chat, every model, Slack-style threads",
    description: seoDescription,
    url: "/",
    locale: "en_US",
  },
  twitter: {
    card: "summary_large_image",
    title: "ProperChat - one chat, every model, Slack-style threads",
    description: seoDescription,
  },
  robots: { index: true, follow: true },
  icons: { icon: "/favicon.svg" },
};

const jsonLd = {
  "@context": "https://schema.org",
  "@type": "WebApplication",
  name: "ProperChat",
  url: SITE_URL,
  description: seoDescription,
  applicationCategory: "ProductivityApplication",
  operatingSystem: "Web",
  offers: {
    "@type": "Offer",
    price: "0",
    priceCurrency: "USD",
  },
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#faf9f5" },
    { media: "(prefers-color-scheme: dark)", color: "#262624" },
  ],
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <ThemeScript />
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
        />
      </head>
      <body className={`${geistSans.variable} font-sans`}>
        {children}
      </body>
    </html>
  );
}
