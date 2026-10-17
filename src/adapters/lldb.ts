import type { Adapter } from "./types.js";
export const lldbAdapter: Adapter = { name: "lldb", tools: [], platforms: ["darwin"], requires: ["lldb"], async run() { throw new Error("not implemented"); } };
