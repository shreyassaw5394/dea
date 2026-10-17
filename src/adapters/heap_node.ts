import type { Adapter } from "./types.js";
export const heapNodeAdapter: Adapter = { name: "node-inspector", tools: [], platforms: ["linux", "darwin"], requires: [], async run() { throw new Error("not implemented"); } };
