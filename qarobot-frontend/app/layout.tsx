import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "QA Robot",
  description: "AI-assisted QA planning, generation, execution, and healing.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
