import type { Metadata } from "next";
import "./globals.css";

const siteUrl = process.env.SITE_URL || "http://localhost:3000";
const allowIndexing = process.env.PUBLIC_INDEXING === "true";

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  title: "Pengiriman Paspor ke Rumah | Batam",
  description:
    "Layanan pengiriman paspor yang sudah selesai ke alamat rumah untuk pemohon Imigrasi Batam.",
  applicationName: "Pengiriman Paspor Batam",
  icons: {
    icon: "/assets/logo-imigrasi.png",
    shortcut: "/assets/logo-imigrasi.png",
  },
  openGraph: {
    type: "website",
    locale: "id_ID",
    title: "Pengiriman Paspor ke Rumah",
    description: "Layanan untuk Pemohon Imigrasi Batam",
    images: [{ url: "/og.png", width: 1200, height: 630, alt: "Pengiriman Paspor ke Rumah — Layanan untuk Pemohon Imigrasi Batam" }],
  },
  twitter: {
    card: "summary_large_image",
    title: "Pengiriman Paspor ke Rumah",
    description: "Layanan untuk Pemohon Imigrasi Batam",
    images: ["/og.png"],
  },
  robots: {
    index: allowIndexing,
    follow: allowIndexing,
  },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="id">
      <body>{children}</body>
    </html>
  );
}
