/**
 * What a parent process cannot do on Windows: deliver a signal to a child it
 * forked. The fixtures that run an entry point under a signal call this
 * first.
 *
 * `process.kill(pid, "SIGINT")` on Windows does not raise a signal in the
 * target - it ends it with `TerminateProcess`, and no handler runs. A console
 * control event (Ctrl+C) is the only real path, and it cannot be sent to a
 * child that was started in its own process group. So the parent sends
 * `"signal"` over the IPC channel and the signal is raised here, in the
 * child, by the same call libuv makes when a console really does deliver one:
 * everything downstream - the subscription of the entry point, the order of
 * the stages, the exit code - is the production path.
 */
export function relaySignals(): void {
  process.on("message", (message: unknown) => {
    if (message === "signal") {
      process.emit("SIGINT", "SIGINT");
    }
  });
}
