import type { Adapter } from "./types.js";
export const bpftraceAdapter: Adapter = { name: "bpftrace", tools: [], platforms: ["linux"], requires: ["bpftrace"], async run() { throw new Error("not implemented"); } };
