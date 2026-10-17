// Tries to bind :8080 and fails with EADDRINUSE.
import net from "node:net";
const PORT = Number(process.env.PORT ?? 8080);
const s = net.createServer();
s.on("error", (e) => {
  console.error(`bind :${PORT} failed: ${e.code}`);
  process.exit(1);
});
s.listen(PORT, () => console.log(`unexpectedly bound :${PORT}`));
