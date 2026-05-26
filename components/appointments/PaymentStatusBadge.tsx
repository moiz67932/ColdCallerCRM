import { Badge } from "@/components/ui/badge";
import { formatStatusLabel, getPaymentStatusClass } from "@/lib/appointments/status-formatting";

export function PaymentStatusBadge({ status }: { status: string | null | undefined }) {
  return <Badge className={getPaymentStatusClass(status)}>{formatStatusLabel(status)}</Badge>;
}
