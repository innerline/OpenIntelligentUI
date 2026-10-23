import type { Metadata } from "next";
import { Plus_Jakarta_Sans } from "next/font/google";
import "./globals.css";
import "./chat.css";
import "@copilotkit/react-core/v2/styles.css";
import { Providers } from "./providers";

// THE REDO J08 (2026-10-23): the suite runs local-from-GitHub with zero
// cloud-hosted remnants — the Google Fonts <link> pair is gone. The
// family now self-hosts through next/font: fetched at BUILD time,
// bundled into .next/static, served same-origin; the running app makes
// no font call at all. Spline Sans Mono dropped with it (loaded by the
// old link, referenced nowhere). globals.css resolves the family
// through --font-jakarta with the same system fallbacks.
const jakarta = Plus_Jakarta_Sans({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-jakarta",
  display: "swap",
});

export const metadata: Metadata = {
  // Local default (J08): the old fallback named the hosted demo
  // (opengenerativeui.copilotkit.ai) — inert metadata, but a remnant;
  // deployments set APP_URL and override it.
  metadataBase: new URL(
    process.env.APP_URL ||
      process.env.RENDER_EXTERNAL_URL ||
      "http://localhost:3210",
  ),
  title: "Honey",
  description:
    "Explore ideas, compare your options, and make useful tools with interactive AI responses. Open source, built with CopilotKit.",
  openGraph: {
    title: "Honey",
    description:
      "Answers you can interact with. Open source, built with CopilotKit.",
    type: "website",
  },
  twitter: { card: "summary_large_image" },
  icons: { icon: "/icon.svg" },
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={jakarta.variable}>
      <body className="antialiased">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
