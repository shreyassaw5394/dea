import type { Adapter } from "./types.js";
export const straceAdapter: Adapter = { name: "strace", tools: [], platforms: ["linux"], requires: ["strace"], async run() { throw new Error("not implemented"); } };
