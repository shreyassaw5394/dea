import type { Adapter } from "./types.js";
export const tcpdumpAdapter: Adapter = { name: "tcpdump", tools: [], platforms: ["linux"], requires: ["tcpdump"], async run() { throw new Error("not implemented"); } };
