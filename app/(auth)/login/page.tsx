"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

import { ThemeToggle } from "@/components/theme-toggle";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export default function LoginPage() {
  const router = useRouter();
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setLoading(true);

    try {
      const response = await fetch("/api/auth/login", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({ password }),
      });

      if (!response.ok) {
        const payload = (await response.json().catch(() => ({}))) as { error?: string };
        throw new Error(payload.error ?? "Login failed");
      }

      router.push("/");
      router.refresh();
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "Login failed");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-[radial-gradient(circle_at_20%_10%,_rgba(14,116,144,0.14),_transparent_50%),radial-gradient(circle_at_80%_20%,_rgba(194,65,12,0.18),_transparent_40%),#f1f5f9] px-4 dark:bg-[radial-gradient(circle_at_20%_10%,_rgba(8,145,178,0.22),_transparent_46%),radial-gradient(circle_at_80%_20%,_rgba(251,113,133,0.12),_transparent_38%),#020617]">
      <ThemeToggle className="fixed right-4 top-4" />
      <Card className="w-full max-w-md border-slate-300 bg-white/95 backdrop-blur dark:border-slate-700 dark:bg-slate-950/86">
        <CardHeader>
          <CardTitle>Operator Login</CardTitle>
          <CardDescription>Enter your single-operator admin password to unlock the calling desk.</CardDescription>
        </CardHeader>
        <CardContent>
          <form className="space-y-4" onSubmit={handleSubmit}>
            <div className="space-y-2">
              <Label htmlFor="password">Admin password</Label>
              <Input
                id="password"
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                required
              />
            </div>

            {error ? <p className="text-sm text-red-700">{error}</p> : null}

            <Button className="w-full" disabled={loading} type="submit">
              {loading ? "Unlocking..." : "Unlock CRM"}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
