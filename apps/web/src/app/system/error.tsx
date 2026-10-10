"use client";

import { useRouter } from "next/navigation";

import { Button } from "@/components/ui/button";

import { useAutoRefresh } from "./use-auto-refresh";

/**
 * A defect of the page itself - an outage of the API is drawn by the page,
 * not here. Neither the message nor the stack is shown: both can carry
 * addresses of the server side. The digest is the id Next logged it under.
 *
 * The page's own refresh is gone with the page, so this screen keeps
 * retrying on the same interval: a defect that passes - a render that failed
 * once - does not leave the operator's tab stuck here. Retry by hand goes
 * through the same refresh, so the two never run on top of each other.
 */
export default function SystemError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const router = useRouter();
  const retry = () => {
    router.refresh();
    reset();
  };
  const retryNow = useAutoRefresh(retry);
  return (
    <main className="space-y-4">
      <h1 className="text-xl font-semibold">System</h1>
      <p className="text-sm">The page failed to render.</p>
      {error.digest !== undefined && (
        <p className="text-sm text-muted-foreground">digest {error.digest}</p>
      )}
      <Button variant="outline" onClick={retryNow}>
        Retry
      </Button>
    </main>
  );
}
