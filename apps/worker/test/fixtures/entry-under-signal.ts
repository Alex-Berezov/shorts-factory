import { relaySignals } from "./relay-signal.js";

/**
 * The real entry point, run as a child process, with the signal a parent
 * cannot deliver on Windows raised in the child (`relaySignals`).
 */
relaySignals();

await import("../../src/index.js");

process.send?.("started");
