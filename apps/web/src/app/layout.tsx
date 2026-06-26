import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Care-Ops SMS Invariant Lab",
  description:
    "Public rebuild of replay-safe care-ops SMS invariants — dedupe first, intelligence second",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
