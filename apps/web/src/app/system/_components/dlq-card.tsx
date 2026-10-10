import type { DlqStatus } from "@sf/contracts";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { SectionState } from "@/lib/format-status";

import { NoData } from "./no-data";

/** How many dead jobs wait for an operator. */
export function DlqCard({ state }: { state: SectionState<DlqStatus> }) {
  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between space-y-0">
        <CardTitle className="text-base">Dead letter queue</CardTitle>
        {state.kind === "data" && state.data.size > 0 && (
          <Badge variant="warning">needs a look</Badge>
        )}
      </CardHeader>
      <CardContent>
        {state.kind === "data" ? (
          <p className="text-2xl font-semibold">{state.data.size}</p>
        ) : (
          <NoData label={state.label} />
        )}
      </CardContent>
    </Card>
  );
}
