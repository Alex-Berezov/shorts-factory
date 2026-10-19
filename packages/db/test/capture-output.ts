import { vi } from "vitest";

/**
 * What the code under test writes to the real process streams, one chunk per
 * write, with nothing reaching the terminal. The spies stay until
 * `vi.restoreAllMocks()`; shared by the unit cases of the entry points
 * (`cli-run.test.ts`) and the run of `db:migrate` on the test database
 * (`migrate.int.test.ts`), so a change of how output is caught is made once.
 */
export function captureProcessOutput(): { out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    out.push(String(chunk));
    return true;
  });
  vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
    err.push(String(chunk));
    return true;
  });
  return { out, err };
}
