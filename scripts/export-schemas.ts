// Regenerates docs/mcp-contracts.md JSON schema section from src/contracts.ts.
import { writeFileSync, readFileSync } from "node:fs";
import { exportJsonSchemas } from "../src/contracts.js";

const schemas = exportJsonSchemas();
const marker = "<!-- schemas:start -->";
const end = "<!-- schemas:end -->";
const path = "docs/mcp-contracts.md";
const md = readFileSync(path, "utf8");
const body = Object.entries(schemas)
  .map(([name, schema]) => `### ${name}\n\n\`\`\`json\n${JSON.stringify(schema, null, 2)}\n\`\`\`\n`)
  .join("\n");
const next = md.slice(0, md.indexOf(marker) + marker.length) + "\n\n" + body + "\n" + md.slice(md.indexOf(end));
writeFileSync(path, next);
console.log(`wrote ${Object.keys(schemas).length} schemas to ${path}`);
