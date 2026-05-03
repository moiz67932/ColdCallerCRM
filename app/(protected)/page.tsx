import Link from "next/link";
import { endOfDay, formatDistanceToNowStrict, startOfDay } from "date-fns";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { prisma } from "@/lib/workstation-db";

export default async function DashboardPage() {
  const now = new Date();
  const dayStart = startOfDay(now);
  const dayEnd = endOfDay(now);

  let callsAttempted = 0;
  let answered = 0;
  let voicemails = 0;
  let interested = 0;
  let callbacksDueToday = 0;
  let recentCalls: Array<{
    id: string;
    status: string;
    outcome: string | null;
    createdAt: Date;
    lead: {
      businessName: string | null;
      phoneNumber: string;
      leadList: {
        name: string;
      };
    };
  }> = [];

  if (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY) {
    const results = await Promise.all([
      prisma.callAttempt.count({
        where: {
          createdAt: {
            gte: dayStart,
            lte: dayEnd,
          },
        },
      }),
      prisma.callAttempt.count({
        where: {
          createdAt: {
            gte: dayStart,
            lte: dayEnd,
          },
          outcome: "answered",
        },
      }),
      prisma.callAttempt.count({
        where: {
          createdAt: {
            gte: dayStart,
            lte: dayEnd,
          },
          outcome: "voicemail",
        },
      }),
      prisma.callAttempt.count({
        where: {
          createdAt: {
            gte: dayStart,
            lte: dayEnd,
          },
          outcome: "interested",
        },
      }),
      prisma.followUp.count({
        where: {
          status: "open",
          dueAt: {
            gte: dayStart,
            lte: dayEnd,
          },
        },
      }),
      prisma.callAttempt.findMany({
        include: {
          lead: {
            include: {
              leadList: true,
            },
          },
        },
        orderBy: { createdAt: "desc" },
        take: 10,
      }),
    ]);

    [callsAttempted, answered, voicemails, interested, callbacksDueToday, recentCalls] = results;
  }

  return (
    <div className="space-y-4">
      <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
        <p className="text-xs uppercase tracking-[0.2em] text-cyan-700">Today</p>
        <h2 className="text-2xl font-semibold tracking-tight">Outbound Calling Snapshot</h2>
        <p className="mt-1 text-sm text-slate-600">Focused stats for your single-operator cold calling desk.</p>
      </section>

      <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
        <StatCard title="Calls attempted" value={callsAttempted} />
        <StatCard title="Answered" value={answered} />
        <StatCard title="Voicemails" value={voicemails} />
        <StatCard title="Interested" value={interested} />
        <StatCard title="Callbacks due today" value={callbacksDueToday} />
      </section>

      <section className="grid gap-4 xl:grid-cols-3">
        <Card className="xl:col-span-2">
          <CardHeader>
            <CardTitle>Recent call activity</CardTitle>
            <CardDescription>Latest call attempts with outcomes and lead context.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            {recentCalls.length === 0 ? (
              <p className="text-sm text-slate-500">No call attempts yet. Head to the calling workspace to start dialing.</p>
            ) : (
              recentCalls.map((call) => (
                <Link
                  key={call.id}
                  href={`/history/${call.id}`}
                  className="flex items-center justify-between rounded-lg border border-slate-200 px-3 py-2 hover:bg-slate-50"
                >
                  <div>
                    <p className="font-medium">
                      {call.lead.businessName ?? "Untitled business"} <span className="text-slate-500">({call.lead.phoneNumber})</span>
                    </p>
                    <p className="text-xs text-slate-500">{call.lead.leadList.name}</p>
                  </div>
                  <div className="text-right">
                    <Badge variant="secondary">{call.outcome ?? call.status}</Badge>
                    <p className="mt-1 text-xs text-slate-500">{formatDistanceToNowStrict(call.createdAt, { addSuffix: true })}</p>
                  </div>
                </Link>
              ))
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Quick filters</CardTitle>
            <CardDescription>Jump straight into the next action.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <Link className="block rounded-md bg-slate-900 px-3 py-2 text-white" href="/queue">
              Open Calling Workspace
            </Link>
            <Link className="block rounded-md bg-slate-100 px-3 py-2" href="/history?outcome=interested">
              View Interested Calls
            </Link>
            <Link className="block rounded-md bg-slate-100 px-3 py-2" href="/history?outcome=callback">
              View Callback Outcomes
            </Link>
            <Link className="block rounded-md bg-slate-100 px-3 py-2" href="/import">
              Import New Lead List
            </Link>
          </CardContent>
        </Card>
      </section>
    </div>
  );
}

function StatCard({ title, value }: { title: string; value: number }) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardDescription>{title}</CardDescription>
      </CardHeader>
      <CardContent>
        <p className="text-3xl font-semibold tabular-nums">{value}</p>
      </CardContent>
    </Card>
  );
}
