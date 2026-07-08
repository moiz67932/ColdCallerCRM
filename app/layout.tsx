import type { Metadata } from "next";
import "./globals.css";

const themeScript = `
(() => {
  try {
    const storedTheme = window.localStorage.getItem("coldcaller-theme");
    const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
    const theme = storedTheme === "dark" || storedTheme === "light" ? storedTheme : prefersDark ? "dark" : "light";
    document.documentElement.classList.toggle("dark", theme === "dark");
    document.documentElement.dataset.theme = theme;
  } catch {}
})();
`;

export const metadata: Metadata = {
  title: process.env.NEXT_PUBLIC_APP_NAME ?? "ColdCaller CRM",
  description: "Cold calling CRM using Telnyx Call Control and webhook-driven call status",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="h-full antialiased" suppressHydrationWarning>
      <body className="min-h-full">
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
        {children}
      </body>
    </html>
  );
}
