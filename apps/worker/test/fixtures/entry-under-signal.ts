/**
 * The real entry point, run as a child process, plus one thing a parent
 * process cannot do on Windows: deliver a signal.
 *
 * `process.kill(pid, "SIGINT")` on Windows does not raise a signal in the
 * target - it ends it with `TerminateProcess`, and no handler runs. A console
 * control event (Ctrl+C) is the only real path, and it cannot be sent to a
 * child that was started in its own process group. So the parent asks over the
 * IPC channel and the signal is raised here, in the child, by the same call
 * libuv makes when a console really does deliver one: everything downstream -
 * the subscription made in `bootstrap`, the order of the stages, the exit code
 * - is the production path.
 */
process.on("message", (message: unknown) => {
  if (message === "signal") {
    process.emit("SIGINT", "SIGINT");
  }
});

await import("../../src/index.js");

process.send?.("started");
