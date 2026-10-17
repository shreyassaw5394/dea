import { describe, expect, it } from "vitest";
import { parseDockerInspect, attachInfoFromInspect, parseDockerStats, parseDockerTop } from "../../src/adapters/docker.js";

const INSPECT = JSON.stringify([
  {
    Id: "abcdef1234567890abcdef",
    Name: "/api-1",
    Config: { Image: "node:22", Cmd: ["node", "server.js"], Entrypoint: null },
    State: { Status: "running", Running: true, Pid: 4242, OOMKilled: false, ExitCode: 0, RestartCount: 2 },
    HostConfig: { Memory: 536870912, NanoCpus: 500000000, PidsLimit: null },
    RestartCount: 2,
    NetworkSettings: { Ports: { "3000/tcp": [{ HostIp: "0.0.0.0", HostPort: "3000" }] } },
  },
]);

describe("docker parsers", () => {
  it("parses inspect → attach info", () => {
    const d = parseDockerInspect(INSPECT)!;
    const a = attachInfoFromInspect(d);
    expect(a).toMatchObject({ id: "abcdef123456", name: "api-1", pid: 4242, comm: "node", cmdline: "node server.js", running: true, image: "node:22" });
  });
  it("parses stats json", () => {
    const s = parseDockerStats('{"CPUPerc":"12.34%","MemUsage":"120MiB / 512MiB","MemPerc":"23.44%","NetIO":"1kB / 2kB","BlockIO":"0B / 0B","PIDs":"7"}\n')!;
    expect(s.cpu_pct).toBeCloseTo(12.34);
    expect(s.pids).toBe(7);
  });
  it("parses top", () => {
    const rows = parseDockerTop("PID   COMMAND   ARGS\n4242  node      node server.js\n4260  sh        sh -c sleep\n");
    expect(rows).toEqual([
      { pid: 4242, comm: "node", args: "node server.js" },
      { pid: 4260, comm: "sh", args: "sh -c sleep" },
    ]);
  });
  it("returns undefined on garbage", () => {
    expect(parseDockerInspect("[]")).toBeUndefined();
    expect(parseDockerStats("")).toBeUndefined();
  });
});
