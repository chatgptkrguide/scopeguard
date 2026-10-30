import type { Metadata } from "next";
import { Literata, Public_Sans } from "next/font/google";
import "./globals.css";

// Literata sets what the client wrote and the scope itself; Public Sans runs the interface.
const literata = Literata({
  variable: "--font-literata",
  subsets: ["latin"],
});

const publicSans = Public_Sans({
  variable: "--font-public-sans",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "ScopeGuard",
  description:
    "Catch scope creep in client messages and bill it with PayPal before you do the extra work.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${literata.variable} ${publicSans.variable} h-full antialiased`}>
      <body className="min-h-full">{children}</body>
    </html>
  );
}
