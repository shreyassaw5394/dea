// Send N requests to /work and /slow to exercise the leak and the slow path.
import http from "node:http";
const PORT = Number(process.env.PORT ?? 3000);
const N = Number(process.argv[2] ?? 300);
const SLOW = Number(process.argv[3] ?? 5);
const body = "y".repeat(64 * 1024);
function req(path, data) {
  return new Promise((resolve) => {
    const r = http.request({ host: "127.0.0.1", port: PORT, path, method: data ? "POST" : "GET" }, (res) => {
      res.resume();
      res.on("end", resolve);
    });
    r.on("error", resolve);
    if (data) r.write(data);
    r.end();
  });
}
const t0 = Date.now();
for (let i = 0; i < N; i++) await req("/work", body);
for (let i = 0; i < SLOW; i++) await req("/slow");
console.log(`sent ${N} /work + ${SLOW} /slow in ${Date.now() - t0} ms`);
