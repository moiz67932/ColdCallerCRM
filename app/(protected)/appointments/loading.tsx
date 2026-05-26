import { Card, CardContent, CardHeader } from "@/components/ui/card";

export default function AppointmentsLoading() {
  return (
    <Card>
      <CardHeader>
        <div className="h-5 w-56 rounded bg-slate-200" />
        <div className="h-4 w-96 max-w-full rounded bg-slate-100" />
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="h-9 rounded bg-slate-100" />
        <div className="h-48 rounded bg-slate-100" />
      </CardContent>
    </Card>
  );
}
