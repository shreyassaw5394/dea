# leaky-node

Express-free HTTP server with a closure leak (`/work`) and a slow endpoint (`/slow`).

```bash
npm start            # listens on :3000, prints its pid
npm run load -- 300  # 300 × /work (64 KB each) + 5 × /slow
```

DEA session that diagnoses it: see [docs/showcases.md](../../docs/showcases.md).
