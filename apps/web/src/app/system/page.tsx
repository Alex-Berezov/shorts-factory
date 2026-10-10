import { loadSystemStatus } from "@/lib/api.server";
import { REFRESH_INTERVAL_MS } from "@/lib/auto-refresh";
import { sectionState } from "@/lib/format-status";

import { ApiHealthCard } from "./_components/api-health-card";
import { BudgetTable } from "./_components/budget-table";
import { DlqCard } from "./_components/dlq-card";
import { QueuesTable } from "./_components/queues-table";
import { WorkerCard } from "./_components/worker-card";
import { AutoRefresh } from "./auto-refresh";

/**
 * Rendered on every request, never at build time: the page reads the API
 * with the admin password, and neither exists while `next build` runs
 * (docs/DECISIONS.md, 10.10.2026). `AutoRefresh` re-requests it every
 * `REFRESH_INTERVAL_MS`.
 */
export const dynamic = "force-dynamic";

export default async function SystemPage() {
  const result = await loadSystemStatus();
  const now = new Date();

  return (
    <main className="space-y-6">
      <AutoRefresh />
      <div className="flex items-baseline justify-between">
        <h1 className="text-xl font-semibold">System</h1>
        <p className="text-sm text-muted-foreground">
          as of {now.toISOString()}, refreshes every{" "}
          {REFRESH_INTERVAL_MS / 1000} s
        </p>
      </div>
      <div className="grid gap-4 md:grid-cols-3">
        <ApiHealthCard result={result} />
        <WorkerCard
          state={sectionState(result, (status) => status.worker, "redis")}
          now={now}
        />
        <DlqCard
          state={sectionState(result, (status) => status.dlq, "redis")}
        />
      </div>
      <QueuesTable
        state={sectionState(result, (status) => status.queues, "redis")}
      />
      <BudgetTable
        state={sectionState(result, (status) => status.budget, "db")}
      />
    </main>
  );
}
