import type { DependencyCheck } from "@sf/contracts";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { SystemStatusResult } from "@/lib/api.server";
import {
  formatApiFailure,
  formatFailureReason,
  formatUptime,
} from "@/lib/format-status";

function DependencyRow({
  name,
  check,
}: {
  name: string;
  check: DependencyCheck;
}) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span>{name}</span>
      <span className="flex items-center gap-2">
        {check.reason !== null && (
          <span className="text-muted-foreground">
            {formatFailureReason(check.reason)}
          </span>
        )}
        <Badge variant={check.status === "up" ? "secondary" : "destructive"}>
          {check.status}
        </Badge>
      </span>
    </div>
  );
}

/**
 * Whether the API answered, and what it says about its own dependencies.
 * When it did not, this card is where the kind of failure is shown - the
 * other sections only say there is no data (docs/DECISIONS.md, 10.10.2026).
 */
export function ApiHealthCard({ result }: { result: SystemStatusResult }) {
  if (result.kind !== "ok") {
    return (
      <Card>
        <CardHeader className="flex-row items-center justify-between space-y-0">
          <CardTitle className="text-base">API health</CardTitle>
          <Badge variant="destructive">unavailable</Badge>
        </CardHeader>
        <CardContent className="text-sm">
          <p>{formatApiFailure(result)}</p>
        </CardContent>
      </Card>
    );
  }

  const { build, uptimeSec, checks } = result.data;
  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between space-y-0">
        <CardTitle className="text-base">API health</CardTitle>
        <Badge variant="secondary">answering</Badge>
      </CardHeader>
      <CardContent className="space-y-2 text-sm">
        <DependencyRow name="db" check={checks.db} />
        <DependencyRow name="redis" check={checks.redis} />
        <div className="text-muted-foreground">
          version {build.version ?? "unknown"}, commit{" "}
          {build.commit ?? "unknown"}, up {formatUptime(uptimeSec)}
        </div>
      </CardContent>
    </Card>
  );
}
