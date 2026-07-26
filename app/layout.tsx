import type { Metadata, Viewport } from "next";
import { Public_Sans, Roboto_Mono, Merriweather } from "next/font/google";
import Script from "next/script";
import Link from "next/link";
import { Analytics } from "@vercel/analytics/next";
import { ProofMark } from "@/components/proof-mark";
import { ThemeToggle, THEME_INIT_SCRIPT } from "@/components/theme-toggle";
import { DevModeToggle } from "@/components/dev-mode-toggle";
import { TierSwitcher } from "@/components/tier-switcher";
import { ModelPicker } from "@/components/model-picker";
import { EscalationToggle } from "@/components/escalation-toggle";
import "./globals.css";

const publicSans = Public_Sans({
  variable: "--font-public-sans",
  subsets: ["latin"],
});

const robotoMono = Roboto_Mono({
  variable: "--font-roboto-mono",
  subsets: ["latin"],
});

const merriweather = Merriweather({
  weight: ["700", "900"],
  variable: "--font-merriweather",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "ProofCheck — TTB label verification",
  description: "Checks alcohol label artwork against its application data.",
};

export const viewport: Viewport = {
  // Mobile browser chrome only follows the OS-level prefers-color-scheme here, not our
  // class-based theme choice — it won't track a manual light/dark override via ThemeToggle.
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#faf8f3" },
    { media: "(prefers-color-scheme: dark)", color: "#15130f" },
  ],
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      suppressHydrationWarning
      className={`${publicSans.variable} ${robotoMono.variable} ${merriweather.variable} h-full antialiased`}
    >
      <head>
        <Script id="theme-init" strategy="beforeInteractive" dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
      </head>
      <body className="min-h-full bg-background text-foreground">
        <a
          href="#main-content"
          className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded-lg focus:bg-primary focus:px-4 focus:py-2 focus:text-base focus:font-semibold focus:text-primary-foreground"
        >
          Skip to main content
        </a>
        <header className="sticky top-0 z-10 bg-primary text-primary-foreground shadow-sm">
          <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-x-6 gap-y-2 px-4 py-3">
            <Link href="/" className="flex items-center gap-3">
              {/* 48px sits level with the 50px wordmark lockup, which already sets the header's
                  height — so this costs no layout. The radius must track the tile size to keep the
                  shadow on the mark's corners: rx="6" on a 40-unit viewBox is 6 x 48/40 = 7.2px. */}
              <ProofMark className="h-12 w-12 shrink-0 rounded-[7.2px] shadow-sm" />
              <span className="flex flex-col leading-none">
                <span className="wordmark font-heading text-xl font-bold tracking-tight">ProofCheck</span>
                <span className="mt-0.5 text-sm font-medium text-primary-foreground/75">TTB label verification</span>
              </span>
            </Link>
            <nav className="flex flex-wrap items-center gap-1 text-base" aria-label="Main">
              <Link
                className="rounded-md px-3 py-2 font-medium text-primary-foreground/80 transition-colors hover:bg-white/10 hover:text-primary-foreground"
                href="/"
              >
                Single label
              </Link>
              <Link
                className="rounded-md px-3 py-2 font-medium text-primary-foreground/80 transition-colors hover:bg-white/10 hover:text-primary-foreground"
                href="/batch"
              >
                Batch
              </Link>
              <span className="ml-1 flex items-center gap-2 border-l border-white/20 pl-2">
                <DevModeToggle />
                <TierSwitcher />
                <ModelPicker />
                <EscalationToggle />
                <ThemeToggle />
              </span>
            </nav>
          </div>
        </header>
        <div className="border-b border-white/10 bg-primary/95 px-4 py-2 text-center text-sm text-primary-foreground/70">
          Independent compliance tool — not affiliated with the U.S. Department of the Treasury or the Alcohol and
          Tobacco Tax and Trade Bureau.
        </div>
        <main id="main-content" className="mx-auto max-w-6xl px-4 py-8 sm:py-10">
          {children}
        </main>
        <Analytics />
      </body>
    </html>
  );
}
