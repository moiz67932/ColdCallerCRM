import { redirect } from "next/navigation";

import { isAuthenticated } from "@/lib/auth";

export default async function AuthLayout({ children }: { children: React.ReactNode }) {
  const authed = await isAuthenticated();

  if (authed) {
    redirect("/");
  }

  return children;
}
