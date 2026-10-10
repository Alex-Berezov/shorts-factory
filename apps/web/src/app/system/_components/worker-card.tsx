import type { WorkerStatus } from "@sf/contracts";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { type SectionState, formatHeartbeatAge } from "@/lib/format-status";

import { NoData } from "./no-data";

/** The heartbeat the worker left in Redis and whether it is too old. */
export function WorkerCard({
  state,
  now,
}: {
  state: SectionState<WorkerStatus>;
  now: Date;
}) {
  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between space-y-0">
        <CardTitle className="text-base">Worker heartbeat</CardTitle>
        {state.kind === "data" && (
          <Badge variant={state.data.stale ? "destructive" : "secondary"}>
            {state.data.stale ? "stale" : "alive"}
          </Badge>
        )}
      </CardHeader>
      <CardContent className="text-sm">
        {state.kind === "data" ? (
          <p>
            last beat {formatHeartbeatAge(state.data.heartbeatAt, now)}
            {state.data.heartbeatAt !== null && (
              <span className="text-muted-foreground">
                {" "}
                ({state.data.heartbeatAt})
              </span>
            )}
          </p>
        ) : (
          <NoData label={state.label} />
        )}
      </CardContent>
    </Card>
  );
}
