import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Pendulum Simulator",
  description: "A pendulum physics simulator with a movable anchor point.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className="antialiased">{children}</body>
    </html>
  );
}
