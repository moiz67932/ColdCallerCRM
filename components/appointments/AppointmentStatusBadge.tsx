import { Badge } from "@/components/ui/badge";
import { formatStatusLabel, getAppointmentStatusClass } from "@/lib/appointments/status-formatting";

export function AppointmentStatusBadge({ status }: { status: string | null | undefined }) {
  return <Badge className={getAppointmentStatusClass(status)}>{formatStatusLabel(status)}</Badge>;
}
