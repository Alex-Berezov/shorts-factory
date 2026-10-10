import type { BudgetStatus } from "@sf/contracts";

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
import {
  type SectionState,
  formatAmount,
  formatPercent,
  formatPeriod,
} from "@/lib/format-status";

import { NoData } from "./no-data";

/**
 * Spend against every cap. `warn` and `exceeded` are drawn as the guard
 * reported them, not derived from the ratio here.
 */
export function BudgetTable({
  state,
}: {
  state: SectionState<readonly BudgetStatus[]>;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Budget</CardTitle>
      </CardHeader>
      <CardContent>
        {state.kind === "data" ? (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Cap</TableHead>
                <TableHead>Period</TableHead>
                <TableHead className="text-right">Spent / cap</TableHead>
                <TableHead className="text-right">Used</TableHead>
                <TableHead>State</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {state.data.map((budget) => (
                <TableRow key={budget.key}>
                  <TableCell className="font-mono">{budget.key}</TableCell>
                  <TableCell>{formatPeriod(budget)}</TableCell>
                  <TableCell className="text-right">
                    {formatAmount(budget.spent, budget.measure)} /{" "}
                    {formatAmount(budget.cap, budget.measure)}
                  </TableCell>
                  <TableCell className="text-right">
                    {formatPercent(budget.ratio)}
                  </TableCell>
                  <TableCell className="space-x-1">
                    {budget.exceeded && (
                      <Badge variant="destructive">exceeded</Badge>
                    )}
                    {budget.warn && !budget.exceeded && (
                      <Badge variant="warning">warn</Badge>
                    )}
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
