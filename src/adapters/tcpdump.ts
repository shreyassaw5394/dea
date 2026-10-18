/**
 * tcpdump adapter: capture_traffic, scoped to the target's ports (derived from
 * lsof at run time) — never an unbounded capture. Requires consent: true.
 *   tcpdump -i any -nn -tt -q -U -w <pcap> -G N -W 1 '<filter>'
 * then `tcpdump -nn -tt -r <pcap>` is parsed for the summary.
 */
import type { Adapter, AdapterContext } from "./types.js";
import type { ToolResult } from "../contracts.js";
import { ResultBuilder, humanBytes } from "../evidence.js";
import { runCapped, clampDuration, looksLikePermissionError, rootRequiredLimitation, LIMITS, assertSafeBpfFragment, isRoot } from "../safety.js";
import { platform } from "../session.js";
import { targetPids } from "../target.js";
import { parseLsofFields } from "./lsof.js";

export interface PacketLine {
  ts: number;
  proto: "IP" | "IP6" | "ARP" | "other";
  src: string;
  sport?: number;
  dst: string;
  dport?: number;
  flags?: string;
  length?: number;
  kind: "tcp" | "udp" | "dns" | "other";
  dnsQuery?: string;
  tlsSni?: string;
  retransmit?: boolean;
  /** "In"/"Out" when captured with -i any (Linux SLL2). */
  dir?: string;
  /** TCP sequence range text, e.g. "1:101" or "1". */
  seq?: string;
}

function splitHostPort(s: string): { host: string; port?: number } {
  const m = /^(.*)\.(\d+)$/.exec(s);
  if (!m) return { host: s };
  return { host: m[1]!, port: Number(m[2]) };
}

/** Parse `tcpdump -nn -tt -r file` text lines (tcp/udp/dns). Pure. */
export function parseTcpdump(raw: string): PacketLine[] {
  const out: PacketLine[] = [];
  for (const line of raw.split("\n")) {
    const m = /^(\d+\.\d+) (?:[\w.-]+\s+(In|Out|B|M|P)\s+)?(IP6?|ARP) (.*)$/.exec(line.trim());
    if (!m) continue;
    const ts = Number(m[1]);
    const dir = m[2];
    const proto = m[3] as PacketLine["proto"];
    const rest = m[4]!;
    const flow = /^(\S+) > (\S+): (.*)$/.exec(rest);
    if (!flow) continue;
    const s = splitHostPort(flow[1]!);
    const d = splitHostPort(flow[2]!.replace(/:$/, ""));
    const body = flow[3]!;
    const pkt: PacketLine = { ts, proto, src: s.host, sport: s.port, dst: d.host, dport: d.port, kind: "other", dir };
    if (/^Flags \[/.test(body)) {
      pkt.kind = "tcp";
      pkt.flags = /^Flags \[([^\]]*)\]/.exec(body)?.[1];
      pkt.seq = /\bseq (\d+(?::\d+)?)/.exec(body)?.[1];
      const len = /length (\d+)/.exec(body);
      if (len) pkt.length = Number(len[1]);
      // TLS ClientHello SNI is only visible with -X/-A; tcpdump -v prints "(SNI=...)" on some builds.
      const sni = /SNI=([A-Za-z0-9.-]+)/.exec(body);
      if (sni) pkt.tlsSni = sni[1];
    } else if (/^\d+\+?\$? [A-Z]+\??/.test(body) || /^\d+ [A-Z]+\? /.test(body) || (/\b(A|AAAA|CNAME|MX|TXT|SRV)\?/.test(body) && (d.port === 53 || s.port === 53))) {
      pkt.kind = "dns";
      const q = /\b(?:A|AAAA|CNAME|MX|TXT|SRV|PTR)\? ([^\s,]+)/.exec(body);
      if (q) pkt.dnsQuery = q[1]!.replace(/\.$/, "");
    } else if (/^UDP, length (\d+)/.test(body)) {
      pkt.kind = "udp";
      pkt.length = Number(/length (\d+)/.exec(body)![1]);
    }
    out.push(pkt);
  }
  return out;
}

export interface TrafficSummary {
  packets: number;
  bytes: number;
  byRemote: Array<{ remote: string; packets: number; bytes: number; rst: number; syn: number; fin: number; retransmits: number }>;
  rst: number;
  syn_no_synack: number;
  retransmits: number;
  dns: Array<{ name: string; count: number }>;
  sni: Array<{ name: string; count: number }>;
  duration_s: number;
}

/** Summarize packets relative to a set of local ports. Pure. */
export function summarizeTraffic(pkts: PacketLine[], localPorts: Set<number>): TrafficSummary {
  const remotes = new Map<string, TrafficSummary["byRemote"][number]>();
  const dns = new Map<string, number>();
  const sni = new Map<string, number>();
  let rst = 0;
  let retransmits = 0;
  let bytes = 0;
  // With `-i any` on Linux, loopback traffic is seen twice (In + Out). Collapse exact duplicates within 2 ms.
  const deduped: PacketLine[] = [];
  const lastSeen = new Map<string, number>();
  for (const p of pkts) {
    const key = `${p.src}:${p.sport}>${p.dst}:${p.dport}|${p.flags ?? ""}|${p.seq ?? ""}|${p.length ?? ""}|${p.kind}`;
    const prev = lastSeen.get(key);
    lastSeen.set(key, p.ts);
    if (prev !== undefined && p.ts - prev < 0.002 && p.dir !== undefined) continue;
    deduped.push(p);
  }
  const seenSeq = new Map<string, number>(); // flow|seq → first ts, for retransmit detection
  const syns = new Map<string, number>();
  const synacks = new Set<string>();
  for (const p of deduped) {
    const isLocalSrc = p.sport !== undefined && localPorts.has(p.sport);
    const remoteHost = isLocalSrc ? p.dst : p.src;
    const r = remotes.get(remoteHost) ?? { remote: remoteHost, packets: 0, bytes: 0, rst: 0, syn: 0, fin: 0, retransmits: 0 };
    r.packets++;
    r.bytes += p.length ?? 0;
    bytes += p.length ?? 0;
    if (p.kind === "tcp" && p.flags) {
      if (p.flags.includes("R")) {
        r.rst++;
        rst++;
      }
      if (p.flags === "S") {
        r.syn++;
        syns.set(`${p.src}:${p.sport}>${p.dst}:${p.dport}`, (syns.get(`${p.src}:${p.sport}>${p.dst}:${p.dport}`) ?? 0) + 1);
      }
      if (p.flags === "S.") synacks.add(`${p.dst}:${p.dport}>${p.src}:${p.sport}`);
      if (p.flags.includes("F")) r.fin++;
      if ((p.length ?? 0) > 0 && p.seq) {
        const key = `${p.src}:${p.sport}>${p.dst}:${p.dport}|${p.seq}`;
        const first = seenSeq.get(key);
        if (first !== undefined && p.ts - first > 0.002) {
          r.retransmits++;
          retransmits++;
        } else if (first === undefined) seenSeq.set(key, p.ts);
      }
    }
    if (p.kind === "dns" && p.dnsQuery) dns.set(p.dnsQuery, (dns.get(p.dnsQuery) ?? 0) + 1);
    if (p.tlsSni) sni.set(p.tlsSni, (sni.get(p.tlsSni) ?? 0) + 1);
    remotes.set(remoteHost, r);
  }
  let synNoAck = 0;
  for (const [flow, n] of syns) if (!synacks.has(flow)) synNoAck += n;
  const ts = deduped.map((p) => p.ts);
  return {
    packets: deduped.length,
    bytes,
    byRemote: [...remotes.values()].sort((a, b) => b.bytes - a.bytes || b.packets - a.packets),
    rst,
    syn_no_synack: synNoAck,
    retransmits,
    dns: [...dns].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count),
    sni: [...sni].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count),
    duration_s: ts.length ? Math.round((Math.max(...ts) - Math.min(...ts)) * 100) / 100 : 0,
  };
}

/** Build the BPF filter from the target's ports; refuse an unbounded capture. Pure. */
export function buildFilter(ports: number[], extra?: string): string {
  const uniq = [...new Set(ports.filter((p) => p > 0 && p < 65536))].slice(0, 40);
  if (!uniq.length) throw new Error("target has no sockets/ports to scope the capture to; refusing an unbounded capture");
  const portExpr = uniq.length === 1 ? `port ${uniq[0]}` : `(${uniq.map((p) => `port ${p}`).join(" or ")})`;
  const base = `(${portExpr} or (udp and port 53))`;
  return extra ? `${base} and (${assertSafeBpfFragment(extra)})` : base;
}

/** Shared by capture_traffic and `dea import`: packets → evidence + findings. */
export function summarizeCaptureEvidence(b: ResultBuilder, pkts: PacketLine[], localPorts: Set<number>, meta: { filter: string; duration: number; pcapPath?: string; textPath: string }): void {
  const { filter, duration } = meta;
  const local = localPorts;
  const s = summarizeTraffic(pkts, local);
  const filterEv = b.evidenceOf("note", `filter: ${filter}`, { filter, ports: [...local].slice(0, 40), duration_s: duration });
  const totalEv = b.evidenceOf("packet_summary", `${s.packets} packets, ${humanBytes(s.bytes)} payload over ${s.duration_s}s; RST=${s.rst} retransmit≈${s.retransmits} unanswered SYN=${s.syn_no_synack}`, { name: "packets", packets: s.packets, bytes: s.bytes, rst: s.rst, retransmits: s.retransmits, syn_no_synack: s.syn_no_synack, duration_s: s.duration_s }, { artifact: (meta.pcapPath ?? meta.textPath) });
  const remoteEv = b.evidenceOf("packet_summary", s.byRemote.length ? `per remote: ${s.byRemote.slice(0, 5).map((r2) => `${r2.remote} ${r2.packets}p/${humanBytes(r2.bytes)}${r2.rst ? ` RST×${r2.rst}` : ""}${r2.retransmits ? ` rtx×${r2.retransmits}` : ""}`).join("; ")}` : "no packets matched", s.byRemote.slice(0, 25), { artifact: meta.textPath });
  if (s.dns.length) b.evidenceOf("dns_query", `DNS: ${s.dns.slice(0, 6).map((d) => `${d.name}×${d.count}`).join(", ")}`, s.dns.slice(0, 30), { artifact: meta.textPath });
  if (s.sni.length) b.evidenceOf("tls_sni", `TLS SNI: ${s.sni.slice(0, 6).map((d) => `${d.name}×${d.count}`).join(", ")}`, s.sni.slice(0, 30), { artifact: meta.textPath });

  if (s.packets === 0) b.finding("info", `no packets on the target's ports in ${duration}s`, [totalEv, filterEv]);
  if (s.rst > 0) {
    const worst = [...s.byRemote].sort((a, c) => c.rst - a.rst)[0]!;
    b.finding(s.rst >= 10 ? "high" : "warn", `${s.rst} TCP RST(s), most with ${worst.remote} (${worst.rst}) — connections are being refused or torn down abruptly`, [totalEv, remoteEv], "observed");
  }
  if (s.syn_no_synack > 0) b.finding("high", `${s.syn_no_synack} SYN(s) never got a SYN-ACK — a remote is unreachable or firewalled`, [totalEv, remoteEv], "observed");
  if (s.retransmits >= 5) b.finding("warn", `≈${s.retransmits} probable retransmissions — packet loss or a slow peer`, [totalEv], "inferred");
  const dnsRepeat = s.dns.find((d) => d.count >= 20);
  if (dnsRepeat) b.finding("warn", `${dnsRepeat.name} resolved ${dnsRepeat.count}× in ${duration}s — no DNS caching`, [b.evidenceOf("dns_query", "repeated lookups", dnsRepeat)], "inferred");
  if (b.findingCount === 0 && s.packets > 0) b.finding("info", `${s.packets} packets, top remote ${s.byRemote[0]?.remote} (${humanBytes(s.byRemote[0]?.bytes ?? 0)})`, [remoteEv]);
}

async function targetPorts(pids: number[]): Promise<number[]> {
  const r = await runCapped("lsof", ["-nP", "-w", "-a", "-F", "pcufatsinTP", "-i", "-p", pids.join(",")], { timeoutMs: 15_000 });
  const ports: number[] = [];
  for (const e of parseLsofFields(r.stdout)) {
    if (e.type !== "IPv4" && e.type !== "IPv6") continue;
    const local = e.name.split("->")[0]!;
    const port = Number(local.slice(local.lastIndexOf(":") + 1));
    if (port) ports.push(port);
    const remote = e.name.split("->")[1];
    if (remote) {
      const rp = Number(remote.slice(remote.lastIndexOf(":") + 1));
      if (rp) ports.push(rp);
    }
  }
  return ports;
}

async function captureTraffic(ctx: AdapterContext, args: { duration_s?: number; filter?: string }): Promise<ToolResult> {
  const { session, target } = ctx;
  const b = new ResultBuilder("capture_traffic", session, target);
  const pids = targetPids(target);
  if (!pids.length) return b.fail("no pid; cannot derive the target's ports").build();
  const duration = clampDuration(args.duration_s, 10, LIMITS.MAX_CAPTURE_WALL_MS);
  let filter: string;
  let ports: number[];
  try {
    ports = await targetPorts(pids);
    filter = buildFilter(ports, args.filter);
  } catch (err) {
    b.limitation((err as Error).message);
    return b.fail("refusing unbounded capture").build();
  }
  const pcap = b.artifactPath("capture.pcap");
  const iface = platform() === "linux" ? "any" : "any";
  const tdArgs = ["-i", iface, "-nn", "-q", "-U", "-s", "256", "-w", pcap, "-G", String(duration), "-W", "1", filter];
  const r = await runCapped("tcpdump", tdArgs, { timeoutMs: duration * 1000 + LIMITS.DURATION_SLACK_MS + 3000 });
  if (looksLikePermissionError(r.stderr) || /You don't have permission|Operation not permitted|cannot open BPF device/i.test(r.stderr)) {
    b.limitation(rootRequiredLimitation("capture_traffic", `tcpdump ${tdArgs.map((a) => (a === filter ? `'${a}'` : a)).join(" ")}`));
    if (platform() === "darwin") b.limitation("macOS: add yourself to the access_bpf group (install Wireshark's ChmodBPF) or run with sudo");
    if (platform() === "linux") b.limitation("Linux: sudo setcap cap_net_raw,cap_net_admin=eip $(which tcpdump)  grants capture without root");
    return b.fail("tcpdump needs permissions").build();
  }
  const art = await b.addArtifact(pcap, "pcap", { description: `tcpdump ${duration}s, filter: ${filter}` });
  const read = await runCapped("tcpdump", ["-nn", "-tt", "-r", pcap], { timeoutMs: 30_000 });
  const textPath = await b.writeArtifact("capture.txt", read.stdout, "raw_text", "tcpdump -nn -tt -r capture.pcap");
  summarizeCaptureEvidence(b, parseTcpdump(read.stdout), new Set(ports), { filter, duration, pcapPath: art.path, textPath });
  b.limitation("retransmits = same flow and TCP seq range seen again >2 ms later (loopback In/Out duplicates collapsed); open the .pcap in Wireshark for exact analysis");
  b.limitation("TLS SNI and payloads need a deeper snaplen/-v; this capture used -s 256 -q. Raw .pcap may contain secrets and is NOT redacted");
  if (!isRoot()) b.limitation("capture ran without root — if it worked, your user has BPF access");
  b.next("inspect_sockets", "trace_syscalls");
  return b.build();
}

export const tcpdumpAdapter: Adapter = {
  name: "tcpdump",
  tools: ["capture_traffic"],
  platforms: ["linux", "darwin"],
  requires: ["tcpdump", "lsof"],
  install: { linux: "sudo apt install tcpdump", darwin: "preinstalled (/usr/sbin/tcpdump); needs sudo or access_bpf group" },
  priority: 10,
  check(base, env) {
    if (!env.isRoot) base.notes.push("needs root or CAP_NET_RAW / access_bpf group; requires consent: true");
    return base;
  },
  async run(tool, args, ctx) {
    if (tool !== "capture_traffic") throw new Error(`tcpdump adapter cannot run ${tool}`);
    return captureTraffic(ctx, args as { duration_s?: number; filter?: string });
  },
};
