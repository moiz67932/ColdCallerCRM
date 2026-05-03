"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { cn } from "@/lib/utils";

const items = [
  { href: "/", label: "Dashboard" },
  { href: "/import", label: "Import" },
  { href: "/queue", label: "Workspace" },
  { href: "/history", label: "History" },
  { href: "/automations", label: "Automations" },
];

export function MobileNav() {
  const pathname = usePathname();

  return (
    <nav className="fixed inset-x-3 bottom-3 z-40 grid grid-cols-5 rounded-xl border border-slate-200 bg-white p-1 text-center text-[11px] shadow-lg md:hidden">
      {items.map((item) => {
        const active = pathname === item.href || (item.href !== "/" && pathname.startsWith(item.href));

        return (
          <Link
            className={cn("rounded-lg px-2 py-2 text-slate-600", active && "bg-slate-900 text-white")}
            href={item.href}
            key={item.href}
          >
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}
