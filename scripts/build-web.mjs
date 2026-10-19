/** Bundle the pure analyzer for the site: site/assets/debuganything-web.js (ESM). */
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const stub = (f) => join(root, "scripts/web-stubs", f);
const r = await build({
  entryPoints: [join(root, "src/web.ts")],
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  minify: true,
  outfile: join(root, "site/assets/debuganything-web.js"),
  alias: {
    execa: stub("execa.js"),
    "node:fs": stub("fs.js"),
    fs: stub("fs.js"),
    "node:fs/promises": stub("fsp.js"),
    "node:path": stub("path.js"),
    path: stub("path.js"),
    "node:child_process": stub("cp.js"),
    "node:os": stub("os.js"),
    "node:crypto": stub("crypto.js"),
  },
  banner: { js: 'var process=globalThis.process??{env:{},platform:"linux",cwd:()=>"/"};var Buffer=globalThis.Buffer??{byteLength:(s)=>new TextEncoder().encode(String(s)).length,from:(s)=>new TextEncoder().encode(String(s)),isBuffer:()=>false};' },
  logLevel: "info",
  metafile: true,
});
const out = Object.entries(r.metafile.outputs)[0];
console.log(`${out[0]}: ${(out[1].bytes / 1024).toFixed(0)} KB`);
