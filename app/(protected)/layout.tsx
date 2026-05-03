import { redirect } from "next/navigation";

import { AppShell } from "@/components/layout/app-shell";
import { MobileNav } from "@/components/layout/mobile-nav";
import { isAuthenticated } from "@/lib/auth";

export default async function ProtectedLayout({ children }: { children: React.ReactNode }) {
  const authed = await isAuthenticated();

  if (!authed) {
    redirect("/login");
  }

  return (
    <AppShell>
      <MobileNav />
      {children}
    </AppShell>
  );
}
