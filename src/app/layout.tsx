import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "Ledgerline — Business intelligence for growing companies", template: "%s · Ledgerline" },
  description:
    "Books, documents, tender intelligence and reconciliation for Rwandan businesses and their advisors.",
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
