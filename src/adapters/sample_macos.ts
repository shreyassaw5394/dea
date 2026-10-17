import type { Adapter } from "./types.js";
export const sampleMacosAdapter: Adapter = { name: "sample", tools: [], platforms: ["darwin"], requires: ["sample"], async run() { throw new Error("not implemented"); } };
