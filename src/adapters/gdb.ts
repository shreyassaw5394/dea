import type { Adapter } from "./types.js";
export const gdbAdapter: Adapter = { name: "gdb", tools: [], platforms: ["linux"], requires: ["gdb"], async run() { throw new Error("not implemented"); } };
