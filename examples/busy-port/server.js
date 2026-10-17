// Holds :8080 forever.
import http from "node:http";
const PORT = Number(process.env.PORT ?? 8080);
http.createServer((_q, s) => s.end("I own the port\n")).listen(PORT, () => console.log(`busy-port holder on :${PORT} pid=${process.pid}`));
