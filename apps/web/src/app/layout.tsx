import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Care-Ops SMS Idempotency Demo",
  description:
    "Sanitized demo of replay-safe Twilio webhook and outbound SMS idempotency patterns",
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
