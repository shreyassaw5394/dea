// Deliberately broken HTTP server for DEA showcases. No dependencies.
//   /work  — stores every request body in a module-level array via a closure (leak)
//   /slow  — sync fs.readFileSync in a loop + a setTimeout(…, 800) (slow)
//   /      — health
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT ?? 3000);

// The leak: a closure keeps every "job" alive forever.
const retained = [];
function makeJob(body) {
  const payload = Buffer.from(body); // retained bytes
  const onDone = () => payload.length; // closure captures payload
  return { body, onDone, createdAt: Date.now() };
}

const bigFile = path.join(__dirname, "server.js");

const server = http.createServer((req, res) => {
  if (req.url === "/work") {
    let chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString() || "x".repeat(64 * 1024);
      retained.push(makeJob(body)); // never removed
      res.end(`retained=${retained.length}\n`);
    });
    return;
  }
  if (req.url === "/slow") {
    let total = 0;
    for (let i = 0; i < 400; i++) total += fs.readFileSync(bigFile).length; // sync I/O in a loop
    setTimeout(() => res.end(`slow done bytes=${total}\n`), 800);
    return;
  }
  res.end("ok\n");
});

server.listen(PORT, () => {
  console.log(`leaky-node listening on http://127.0.0.1:${PORT}  pid=${process.pid}`);
  console.log("endpoints: /work (leaks), /slow (slow), / (ok)");
});
