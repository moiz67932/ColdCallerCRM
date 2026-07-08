"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { BarChart3, Bot, CalendarClock, Clock3, Import, PhoneCall, Settings } from "lucide-react";
import { useState } from "react";

import { ThemeToggle } from "@/components/theme-toggle";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

type AppShellProps = {
  children: React.ReactNode;
};

const navItems = [
  { href: "/", label: "Dashboard", icon: BarChart3 },
  { href: "/import", label: "Lead Import", icon: Import },
  { href: "/queue", label: "Calling Workspace", icon: PhoneCall },
  { href: "/history", label: "Call History", icon: Clock3 },
  { href: "/appointments", label: "Appointments", icon: CalendarClock },
  { href: "/automations", label: "Automations", icon: Bot },
  { href: "/settings", label: "Settings", icon: Settings },
];

export function AppShell({ children }: AppShellProps) {
  const pathname = usePathname();
  const router = useRouter();
  const [loggingOut, setLoggingOut] = useState(false);

  async function logout() {
    setLoggingOut(true);

    try {
      await fetch("/api/auth/logout", {
        method: "POST",
      });

      router.push("/login");
      router.refresh();
    } finally {
      setLoggingOut(false);
    }
  }

  return (
    <div className="min-h-screen bg-[radial-gradient(circle_at_top_left,_rgba(14,116,144,0.14),_transparent_45%),radial-gradient(circle_at_top_right,_rgba(194,65,12,0.12),_transparent_45%),#f8fafc] text-slate-900 dark:bg-[radial-gradient(circle_at_top_left,_rgba(8,145,178,0.20),_transparent_42%),radial-gradient(circle_at_top_right,_rgba(251,113,133,0.10),_transparent_42%),#020617] dark:text-slate-100">
      <div className="mx-auto flex w-full max-w-[1400px] gap-6 px-4 py-4 md:px-6">
        <aside className="hidden w-64 shrink-0 rounded-2xl border border-slate-200 bg-white/90 p-4 shadow-sm backdrop-blur dark:border-slate-700 dark:bg-slate-950/78 dark:shadow-slate-950/40 md:block">
          <div className="mb-4">
            <p className="text-xs uppercase tracking-[0.2em] text-cyan-700 dark:text-cyan-300">ColdCaller</p>
            <h1 className="text-xl font-semibold">Manual CRM Desk</h1>
          </div>

          <nav className="space-y-1">
            {navItems.map((item) => {
              const Icon = item.icon;
              const active = pathname === item.href || (item.href !== "/" && pathname.startsWith(item.href));

              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className={cn(
                    "flex items-center gap-2 rounded-md px-3 py-2 text-sm transition-colors",
                    active
                      ? "bg-slate-900 text-white shadow-sm dark:bg-cyan-400 dark:text-slate-950"
                      : "text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800/80 dark:hover:text-white",
                  )}
                >
                  <Icon className="h-4 w-4" />
                  {item.label}
                </Link>
              );
            })}
          </nav>

          <ThemeToggle className="mt-6 w-full" />
          <Button className="mt-6 w-full" loading={loggingOut} variant="outline" onClick={logout}>
            Log out
          </Button>
        </aside>

        <main className="w-full space-y-4 pb-20 md:pb-0">{children}</main>
      </div>
    </div>
  );
}
