import { describe, expect, it } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { parseTcpdump, summarizeTraffic, buildFilter } from "../../src/adapters/tcpdump.js";

const SAMPLE = `1700000000.000100 IP 10.0.0.9.51000 > 10.0.0.1.3000: Flags [S], seq 1, win 64240, options [mss 1460], length 0
1700000000.000200 IP 10.0.0.1.3000 > 10.0.0.9.51000: Flags [S.], seq 2, ack 2, win 65160, length 0
1700000000.000300 IP 10.0.0.9.51000 > 10.0.0.1.3000: Flags [P.], seq 1:101, ack 1, win 502, length 100
1700000000.100300 IP 10.0.0.9.51000 > 10.0.0.1.3000: Flags [P.], seq 1:101, ack 1, win 502, length 100
1700000000.200000 IP 10.0.0.1.3000 > 10.0.0.9.51000: Flags [R.], seq 1, ack 101, win 0, length 0
1700000000.300000 IP 10.0.0.1.44000 > 10.0.0.53.53: 12345+ A? api.example.com. (33)
1700000000.300500 IP 10.0.0.53.53 > 10.0.0.1.44000: 12345 1/0/0 A 93.184.216.34 (49)
1700000000.400000 IP 10.0.0.1.52000 > 93.184.216.34.443: Flags [S], seq 9, win 64240, length 0
1700000001.400000 IP 10.0.0.1.52000 > 93.184.216.34.443: Flags [S], seq 9, win 64240, length 0
1700000000.500000 IP 10.0.0.1.3000 > 10.0.0.9.51000: UDP, length 20
`;

describe("tcpdump parser", () => {
  it("parses tcp/dns/udp lines", () => {
    const p = parseTcpdump(SAMPLE);
    expect(p).toHaveLength(10);
    expect(p[0]!.kind).toBe("tcp");
    expect(p[0]!.flags).toBe("S");
    expect(p[0]!.dport).toBe(3000);
    const dns = p.find((x) => x.kind === "dns")!;
    expect(dns.dnsQuery).toBe("api.example.com");
    expect(p.at(-1)!.kind).toBe("udp");
  });
  it("summarizes per remote, RSTs, retransmits, unanswered SYNs", () => {
    const s = summarizeTraffic(parseTcpdump(SAMPLE), new Set([3000, 44000, 52000]));
    expect(s.rst).toBe(1);
    expect(s.retransmits).toBe(1);
    expect(s.syn_no_synack).toBe(2);
    expect(s.dns[0]).toEqual({ name: "api.example.com", count: 1 });
    expect(s.byRemote.map((r) => r.remote)).toContain("10.0.0.9");
  });
  it("builds a scoped filter and refuses unbounded captures", () => {
    expect(buildFilter([3000])).toBe("(port 3000 or (udp and port 53))");
    expect(buildFilter([3000, 5432], "tcp")).toBe("((port 3000 or port 5432) or (udp and port 53)) and (tcp)");
    expect(() => buildFilter([])).toThrow(/unbounded/);
    expect(() => buildFilter([80], "port 80; rm -rf /")).toThrow(/unsafe/);
  });
  it("parses a real fixture when present", () => {
    const p = new URL("../fixtures/tcpdump/node-http.txt", import.meta.url);
    if (!existsSync(p)) return;
    expect(parseTcpdump(readFileSync(p, "utf8")).length).toBeGreaterThan(0);
  });
});
