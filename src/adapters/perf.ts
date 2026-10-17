import type { Adapter } from "./types.js";
export const perfAdapter: Adapter = { name: "perf", tools: [], platforms: ["linux"], requires: ["perf"], async run() { throw new Error("not implemented"); } };
