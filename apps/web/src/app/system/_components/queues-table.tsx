import type { QueueStatus } from "@sf/contracts";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { SectionState } from "@/lib/format-status";

import { NoData } from "./no-data";

/** Every queue of the registry, in the order the API reports them. */
export function QueuesTable({
  state,
}: {
  state: SectionState<readonly QueueStatus[]>;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Queues</CardTitle>
      </CardHeader>
      <CardContent>
        {state.kind === "data" ? (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Queue</TableHead>
                <TableHead className="text-right">Waiting</TableHead>
                <TableHead className="text-right">Active</TableHead>
                <TableHead className="text-right">Failed</TableHead>
                <TableHead className="text-right">Delayed</TableHead>
                <TableHead>State</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {state.data.map((queue) => (
                <TableRow key={queue.name}>
                  <TableCell className="font-mono">{queue.name}</TableCell>
                  <TableCell className="text-right">{queue.waiting}</TableCell>
                  <TableCell className="text-right">{queue.active}</TableCell>
                  <TableCell className="text-right">{queue.failed}</TableCell>
                  <TableCell className="text-right">{queue.delayed}</TableCell>
                  <TableCell>
                    {queue.paused && <Badge variant="warning">paused</Badge>}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        ) : (
          <NoData label={state.label} />
        )}
      </CardContent>
    </Card>
  );
}
