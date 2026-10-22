import { relaySignals } from "./relay-signal.js";

/**
 * The real smoke command, run as a child process, with the signal a parent
 * cannot deliver on Windows raised in the child (`relaySignals`).
 */
relaySignals();

await import("../../src/cli/smoke.js");
