# MCP contracts

Every tool — over MCP or the CLI — returns one `ToolResult`. The point of the
project is in two rules the schema enforces:

1. **A `Finding` with no `evidence_ids` is rejected.** Agents only get to
   claim what the evidence supports.
2. **`confidence: "inferred"` is allowed but must be stated.** `observed` means
   the fact was read directly from tool output.

```ts
ToolResult = {
  ok: boolean,
  tool: string,                 // "trace_syscalls"
  session_id: string,           // "" for readiness / list_processes
  target: { kind: "pid"|"container"|"pod"|"command", id, pid?, comm?, runtime?, host, container? },
  duration_ms: number,
  findings: Finding[],          // what we concluded; each MUST cite evidence ids
  evidence: Evidence[],         // raw-ish facts with pointers to artifacts
  limitations: string[],        // "sampled 10 s only", "no symbols", "ran without root"
  suggested_next: string[],     // tool names the agent could run next
  artifacts: Artifact[],        // files written to the session dir
  error?: string,               // when ok === false
  run_id?: string,              // "profile_cpu#2" — address prior results in diff_runs
}
Finding  = { id, severity: "info"|"warn"|"high", summary, evidence_ids: string[] (min 1), confidence: "observed"|"inferred", detail? }
Evidence = { id, kind, summary, data: unknown, artifact?: path, lines?: [from, to] }
Artifact = { path, kind: "raw_text"|"flamegraph_svg"|"folded_stacks"|"heapsnapshot"|"pcap"|"json"|"markdown"|"log", bytes, truncated? }
```

Evidence kinds: `syscall_stat`, `syscall_slow`, `syscall_error`, `stack`,
`stack_summary`, `lock_wait`, `frame_hot`, `socket`, `socket_summary`, `fd`,
`fd_summary`, `packet_summary`, `dns_query`, `tls_sni`, `metric`,
`metric_series`, `heap_retainer`, `heap_summary`, `log_excerpt`, `process`,
`process_list`, `container_state`, `cgroup`, `diff`, `readiness`, `note`.

## Tools

| Tool | Args | Session? |
|---|---|---|
| `readiness` | `{}` | no |
| `attach` | `{ target, kind? }` | creates |
| `detach` | `{ session_id }` | yes |
| `list_processes` | `{ filter?, limit? }` | no |
| `trace_syscalls` | `{ session_id, duration_s?=10 (≤60), categories?=["all"] }` | yes |
| `profile_cpu` | `{ session_id, duration_s?=15 (≤60), consent? }` | yes |
| `dump_stacks` | `{ session_id }` | yes |
| `inspect_sockets` | `{ session_id }` | yes |
| `inspect_files` | `{ session_id, window_s?=3 }` | yes |
| `capture_traffic` | `{ session_id, duration_s?=10 (≤30), filter?, consent: true }` | yes |
| `snapshot_memory` | `{ session_id, heap?=true, window_s?=3 }` | yes |
| `diff_runs` | `{ session_id, a, b }` | yes |
| `container_info` | `{ session_id }` | yes |
| `report` | `{ session_id, out? }` | yes |

## Prompts

`dea_slow`, `dea_leak`, `dea_hang`, `dea_crash`, `dea_port_busy` — guided
investigations (see `src/prompts/index.ts`). Each tells the agent the order of
tools, what to look for, and to never state a cause without an evidence id.

## Session layout

```
~/.debuganything/sessions/<id>/
  session.json        # Session (target, runs index, state)
  runs/001-attach.json, 002-inspect_sockets.json, ...   # full ToolResults
  artifacts/          # raw tool output, flamegraph.svg, .heapsnapshot, .pcap
  report.md           # written by report / detach
```

## JSON Schemas

Generated from `src/contracts.ts` by `npm run schemas`.

<!-- schemas:start -->

### ToolResult

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "ok": {
      "type": "boolean"
    },
    "tool": {
      "type": "string",
      "minLength": 1
    },
    "session_id": {
      "type": "string"
    },
    "target": {
      "type": "object",
      "properties": {
        "kind": {
          "type": "string",
          "enum": [
            "pid",
            "container",
            "pod",
            "command"
          ]
        },
        "id": {
          "type": "string",
          "minLength": 1
        },
        "pid": {
          "type": "integer",
          "exclusiveMinimum": 0,
          "maximum": 9007199254740991
        },
        "comm": {
          "type": "string"
        },
        "cmdline": {
          "type": "string"
        },
        "pids": {
          "type": "array",
          "items": {
            "type": "integer",
            "exclusiveMinimum": 0,
            "maximum": 9007199254740991
          }
        },
        "runtime": {
          "type": "string",
          "enum": [
            "python",
            "node",
            "java",
            "go",
            "native",
            "unknown"
          ]
        },
        "host": {
          "default": "local",
          "type": "string"
        },
        "container": {
          "type": "object",
          "properties": {
            "runtime": {
              "type": "string",
              "enum": [
                "docker",
                "podman",
                "containerd",
                "k8s"
              ]
            },
            "id": {
              "type": "string"
            },
            "name": {
              "type": "string"
            },
            "image": {
              "type": "string"
            },
            "namespace": {
              "type": "string"
            }
          },
          "required": [
            "runtime",
            "id"
          ],
          "additionalProperties": false
        }
      },
      "required": [
        "kind",
        "id",
        "host"
      ],
      "additionalProperties": false
    },
    "duration_ms": {
      "type": "integer",
      "minimum": 0,
      "maximum": 9007199254740991
    },
    "findings": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "id": {
            "type": "string",
            "minLength": 1
          },
          "severity": {
            "type": "string",
            "enum": [
              "info",
              "warn",
              "high"
            ]
          },
          "summary": {
            "type": "string",
            "minLength": 1
          },
          "evidence_ids": {
            "minItems": 1,
            "type": "array",
            "items": {
              "type": "string",
              "minLength": 1
            }
          },
          "confidence": {
            "type": "string",
            "enum": [
              "observed",
              "inferred"
            ]
          },
          "detail": {
            "type": "string"
          }
        },
        "required": [
          "id",
          "severity",
          "summary",
          "evidence_ids",
          "confidence"
        ],
        "additionalProperties": false
      }
    },
    "evidence": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "id": {
            "type": "string",
            "minLength": 1
          },
          "kind": {
            "type": "string",
            "enum": [
              "syscall_stat",
              "syscall_slow",
              "syscall_error",
              "stack",
              "stack_summary",
              "lock_wait",
              "frame_hot",
              "socket",
              "socket_summary",
              "fd",
              "fd_summary",
              "packet_summary",
              "dns_query",
              "tls_sni",
              "metric",
              "metric_series",
              "heap_retainer",
              "heap_summary",
              "log_excerpt",
              "process",
              "process_list",
              "container_state",
              "cgroup",
              "diff",
              "readiness",
              "note"
            ]
          },
          "summary": {
            "type": "string",
            "minLength": 1
          },
          "data": {},
          "artifact": {
            "type": "string"
          },
          "lines": {
            "type": "array",
            "prefixItems": [
              {
                "type": "integer",
                "minimum": 1,
                "maximum": 9007199254740991
              },
              {
                "type": "integer",
                "minimum": 1,
                "maximum": 9007199254740991
              }
            ],
            "items": false,
            "minItems": 2,
            "maxItems": 2
          }
        },
        "required": [
          "id",
          "kind",
          "summary",
          "data"
        ],
        "additionalProperties": false
      }
    },
    "limitations": {
      "type": "array",
      "items": {
        "type": "string"
      }
    },
    "suggested_next": {
      "type": "array",
      "items": {
        "type": "string"
      }
    },
    "artifacts": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "path": {
            "type": "string",
            "minLength": 1
          },
          "kind": {
            "type": "string",
            "enum": [
              "raw_text",
              "flamegraph_svg",
              "folded_stacks",
              "heapsnapshot",
              "pcap",
              "json",
              "markdown",
              "log"
            ]
          },
          "bytes": {
            "type": "integer",
            "minimum": 0,
            "maximum": 9007199254740991
          },
          "truncated": {
            "type": "boolean"
          },
          "description": {
            "type": "string"
          }
        },
        "required": [
          "path",
          "kind",
          "bytes"
        ],
        "additionalProperties": false
      }
    },
    "error": {
      "type": "string"
    },
    "started_at": {
      "type": "string"
    },
    "run_id": {
      "type": "string"
    }
  },
  "required": [
    "ok",
    "tool",
    "session_id",
    "target",
    "duration_ms",
    "findings",
    "evidence",
    "limitations",
    "suggested_next",
    "artifacts"
  ],
  "additionalProperties": false
}
```

### Finding

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "id": {
      "type": "string",
      "minLength": 1
    },
    "severity": {
      "type": "string",
      "enum": [
        "info",
        "warn",
        "high"
      ]
    },
    "summary": {
      "type": "string",
      "minLength": 1
    },
    "evidence_ids": {
      "minItems": 1,
      "type": "array",
      "items": {
        "type": "string",
        "minLength": 1
      }
    },
    "confidence": {
      "type": "string",
      "enum": [
        "observed",
        "inferred"
      ]
    },
    "detail": {
      "type": "string"
    }
  },
  "required": [
    "id",
    "severity",
    "summary",
    "evidence_ids",
    "confidence"
  ],
  "additionalProperties": false
}
```

### Evidence

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "id": {
      "type": "string",
      "minLength": 1
    },
    "kind": {
      "type": "string",
      "enum": [
        "syscall_stat",
        "syscall_slow",
        "syscall_error",
        "stack",
        "stack_summary",
        "lock_wait",
        "frame_hot",
        "socket",
        "socket_summary",
        "fd",
        "fd_summary",
        "packet_summary",
        "dns_query",
        "tls_sni",
        "metric",
        "metric_series",
        "heap_retainer",
        "heap_summary",
        "log_excerpt",
        "process",
        "process_list",
        "container_state",
        "cgroup",
        "diff",
        "readiness",
        "note"
      ]
    },
    "summary": {
      "type": "string",
      "minLength": 1
    },
    "data": {},
    "artifact": {
      "type": "string"
    },
    "lines": {
      "type": "array",
      "prefixItems": [
        {
          "type": "integer",
          "minimum": 1,
          "maximum": 9007199254740991
        },
        {
          "type": "integer",
          "minimum": 1,
          "maximum": 9007199254740991
        }
      ],
      "items": false,
      "minItems": 2,
      "maxItems": 2
    }
  },
  "required": [
    "id",
    "kind",
    "summary",
    "data"
  ],
  "additionalProperties": false
}
```

### Artifact

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "path": {
      "type": "string",
      "minLength": 1
    },
    "kind": {
      "type": "string",
      "enum": [
        "raw_text",
        "flamegraph_svg",
        "folded_stacks",
        "heapsnapshot",
        "pcap",
        "json",
        "markdown",
        "log"
      ]
    },
    "bytes": {
      "type": "integer",
      "minimum": 0,
      "maximum": 9007199254740991
    },
    "truncated": {
      "type": "boolean"
    },
    "description": {
      "type": "string"
    }
  },
  "required": [
    "path",
    "kind",
    "bytes"
  ],
  "additionalProperties": false
}
```

### Target

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "kind": {
      "type": "string",
      "enum": [
        "pid",
        "container",
        "pod",
        "command"
      ]
    },
    "id": {
      "type": "string",
      "minLength": 1
    },
    "pid": {
      "type": "integer",
      "exclusiveMinimum": 0,
      "maximum": 9007199254740991
    },
    "comm": {
      "type": "string"
    },
    "cmdline": {
      "type": "string"
    },
    "pids": {
      "type": "array",
      "items": {
        "type": "integer",
        "exclusiveMinimum": 0,
        "maximum": 9007199254740991
      }
    },
    "runtime": {
      "type": "string",
      "enum": [
        "python",
        "node",
        "java",
        "go",
        "native",
        "unknown"
      ]
    },
    "host": {
      "default": "local",
      "type": "string"
    },
    "container": {
      "type": "object",
      "properties": {
        "runtime": {
          "type": "string",
          "enum": [
            "docker",
            "podman",
            "containerd",
            "k8s"
          ]
        },
        "id": {
          "type": "string"
        },
        "name": {
          "type": "string"
        },
        "image": {
          "type": "string"
        },
        "namespace": {
          "type": "string"
        }
      },
      "required": [
        "runtime",
        "id"
      ],
      "additionalProperties": false
    }
  },
  "required": [
    "kind",
    "id",
    "host"
  ],
  "additionalProperties": false
}
```

### Session

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "id": {
      "type": "string",
      "minLength": 1
    },
    "state": {
      "type": "string",
      "enum": [
        "attached",
        "detached"
      ]
    },
    "target": {
      "type": "object",
      "properties": {
        "kind": {
          "type": "string",
          "enum": [
            "pid",
            "container",
            "pod",
            "command"
          ]
        },
        "id": {
          "type": "string",
          "minLength": 1
        },
        "pid": {
          "type": "integer",
          "exclusiveMinimum": 0,
          "maximum": 9007199254740991
        },
        "comm": {
          "type": "string"
        },
        "cmdline": {
          "type": "string"
        },
        "pids": {
          "type": "array",
          "items": {
            "type": "integer",
            "exclusiveMinimum": 0,
            "maximum": 9007199254740991
          }
        },
        "runtime": {
          "type": "string",
          "enum": [
            "python",
            "node",
            "java",
            "go",
            "native",
            "unknown"
          ]
        },
        "host": {
          "default": "local",
          "type": "string"
        },
        "container": {
          "type": "object",
          "properties": {
            "runtime": {
              "type": "string",
              "enum": [
                "docker",
                "podman",
                "containerd",
                "k8s"
              ]
            },
            "id": {
              "type": "string"
            },
            "name": {
              "type": "string"
            },
            "image": {
              "type": "string"
            },
            "namespace": {
              "type": "string"
            }
          },
          "required": [
            "runtime",
            "id"
          ],
          "additionalProperties": false
        }
      },
      "required": [
        "kind",
        "id",
        "host"
      ],
      "additionalProperties": false
    },
    "created_at": {
      "type": "string"
    },
    "detached_at": {
      "type": "string"
    },
    "dir": {
      "type": "string"
    },
    "platform": {
      "type": "string",
      "enum": [
        "linux",
        "darwin",
        "win32"
      ]
    },
    "runs": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "run_id": {
            "type": "string"
          },
          "tool": {
            "type": "string"
          },
          "ok": {
            "type": "boolean"
          },
          "started_at": {
            "type": "string"
          },
          "duration_ms": {
            "type": "integer",
            "minimum": 0,
            "maximum": 9007199254740991
          },
          "file": {
            "type": "string"
          }
        },
        "required": [
          "run_id",
          "tool",
          "ok",
          "started_at",
          "duration_ms",
          "file"
        ],
        "additionalProperties": false
      }
    },
    "spawned": {
      "type": "object",
      "properties": {
        "pid": {
          "type": "integer",
          "exclusiveMinimum": 0,
          "maximum": 9007199254740991
        },
        "stdout": {
          "type": "string"
        },
        "stderr": {
          "type": "string"
        },
        "exit_code": {
          "anyOf": [
            {
              "type": "integer",
              "minimum": -9007199254740991,
              "maximum": 9007199254740991
            },
            {
              "type": "null"
            }
          ]
        }
      },
      "required": [
        "pid",
        "stdout",
        "stderr"
      ],
      "additionalProperties": false
    }
  },
  "required": [
    "id",
    "state",
    "target",
    "created_at",
    "dir",
    "platform",
    "runs"
  ],
  "additionalProperties": false
}
```

### Readiness

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "os": {
      "type": "string",
      "enum": [
        "linux",
        "darwin",
        "win32"
      ]
    },
    "arch": {
      "type": "string"
    },
    "kernel": {
      "type": "string"
    },
    "node": {
      "type": "string"
    },
    "dea_version": {
      "type": "string"
    },
    "is_root": {
      "type": "boolean"
    },
    "has_sudo_noninteractive": {
      "type": "boolean"
    },
    "permissions": {
      "type": "object",
      "properties": {
        "ptrace_scope": {
          "anyOf": [
            {
              "type": "integer",
              "minimum": -9007199254740991,
              "maximum": 9007199254740991
            },
            {
              "type": "null"
            }
          ]
        },
        "capabilities": {
          "default": [],
          "type": "array",
          "items": {
            "type": "string"
          }
        },
        "sip_enabled": {
          "type": [
            "boolean",
            "null"
          ]
        },
        "developer_mode": {
          "type": [
            "boolean",
            "null"
          ]
        },
        "perf_event_paranoid": {
          "anyOf": [
            {
              "type": "integer",
              "minimum": -9007199254740991,
              "maximum": 9007199254740991
            },
            {
              "type": "null"
            }
          ]
        }
      },
      "required": [
        "ptrace_scope",
        "capabilities",
        "sip_enabled",
        "developer_mode",
        "perf_event_paranoid"
      ],
      "additionalProperties": false
    },
    "providers": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "name": {
            "type": "string"
          },
          "tools": {
            "type": "array",
            "items": {
              "type": "string"
            }
          },
          "status": {
            "type": "string",
            "enum": [
              "ready",
              "missing",
              "no_permission",
              "unsupported_platform",
              "not_implemented"
            ]
          },
          "requires": {
            "type": "array",
            "items": {
              "type": "object",
              "properties": {
                "binary": {
                  "type": "string"
                },
                "path": {
                  "type": [
                    "string",
                    "null"
                  ]
                }
              },
              "required": [
                "binary",
                "path"
              ],
              "additionalProperties": false
            }
          },
          "install_hint": {
            "type": "string"
          },
          "notes": {
            "default": [],
            "type": "array",
            "items": {
              "type": "string"
            }
          }
        },
        "required": [
          "name",
          "tools",
          "status",
          "requires",
          "notes"
        ],
        "additionalProperties": false
      }
    },
    "tools_available": {
      "type": "array",
      "items": {
        "type": "string"
      }
    },
    "tools_unavailable": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "tool": {
            "type": "string"
          },
          "reason": {
            "type": "string"
          }
        },
        "required": [
          "tool",
          "reason"
        ],
        "additionalProperties": false
      }
    },
    "sessions_dir": {
      "type": "string"
    }
  },
  "required": [
    "os",
    "arch",
    "node",
    "dea_version",
    "is_root",
    "has_sudo_noninteractive",
    "permissions",
    "providers",
    "tools_available",
    "tools_unavailable",
    "sessions_dir"
  ],
  "additionalProperties": false
}
```

### ToolArgs

```json
{
  "readiness": {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "type": "object",
    "properties": {},
    "additionalProperties": false
  },
  "attach": {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "type": "object",
    "properties": {
      "target": {
        "type": "string",
        "minLength": 1,
        "description": "pid, container name/id, k8s pod (ns/name), or a command line (with kind=command)"
      },
      "kind": {
        "description": "Defaults to auto-detect: numeric → pid, else container, else command",
        "type": "string",
        "enum": [
          "pid",
          "container",
          "pod",
          "command"
        ]
      }
    },
    "required": [
      "target"
    ],
    "additionalProperties": false
  },
  "detach": {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "type": "object",
    "properties": {
      "session_id": {
        "type": "string",
        "minLength": 1
      }
    },
    "required": [
      "session_id"
    ],
    "additionalProperties": false
  },
  "list_processes": {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "type": "object",
    "properties": {
      "filter": {
        "description": "Substring match on command / args / user",
        "type": "string"
      },
      "limit": {
        "default": 100,
        "type": "integer",
        "minimum": 1,
        "maximum": 500
      }
    },
    "required": [
      "limit"
    ],
    "additionalProperties": false
  },
  "trace_syscalls": {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "type": "object",
    "properties": {
      "session_id": {
        "type": "string",
        "minLength": 1
      },
      "duration_s": {
        "default": 10,
        "type": "integer",
        "minimum": 1,
        "maximum": 60
      },
      "categories": {
        "default": [
          "all"
        ],
        "type": "array",
        "items": {
          "type": "string",
          "enum": [
            "network",
            "file",
            "process",
            "signal",
            "memory",
            "all"
          ]
        }
      }
    },
    "required": [
      "session_id",
      "duration_s",
      "categories"
    ],
    "additionalProperties": false
  },
  "profile_cpu": {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "type": "object",
    "properties": {
      "session_id": {
        "type": "string",
        "minLength": 1
      },
      "duration_s": {
        "default": 15,
        "type": "integer",
        "minimum": 1,
        "maximum": 60
      },
      "consent": {
        "type": "boolean"
      }
    },
    "required": [
      "session_id",
      "duration_s"
    ],
    "additionalProperties": false
  },
  "dump_stacks": {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "type": "object",
    "properties": {
      "session_id": {
        "type": "string",
        "minLength": 1
      }
    },
    "required": [
      "session_id"
    ],
    "additionalProperties": false
  },
  "inspect_sockets": {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "type": "object",
    "properties": {
      "session_id": {
        "type": "string",
        "minLength": 1
      }
    },
    "required": [
      "session_id"
    ],
    "additionalProperties": false
  },
  "inspect_files": {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "type": "object",
    "properties": {
      "session_id": {
        "type": "string",
        "minLength": 1
      },
      "window_s": {
        "default": 3,
        "description": "Observe fd growth over this many seconds (0 = single snapshot)",
        "type": "integer",
        "minimum": 0,
        "maximum": 30
      }
    },
    "required": [
      "session_id",
      "window_s"
    ],
    "additionalProperties": false
  },
  "capture_traffic": {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "type": "object",
    "properties": {
      "session_id": {
        "type": "string",
        "minLength": 1
      },
      "duration_s": {
        "default": 10,
        "type": "integer",
        "minimum": 1,
        "maximum": 30
      },
      "filter": {
        "description": "Extra BPF filter ANDed with the target's ports",
        "type": "string"
      },
      "consent": {
        "description": "Required. Packet capture may contain secrets; ask the user first.",
        "type": "boolean"
      }
    },
    "required": [
      "session_id",
      "duration_s"
    ],
    "additionalProperties": false
  },
  "snapshot_memory": {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "type": "object",
    "properties": {
      "session_id": {
        "type": "string",
        "minLength": 1
      },
      "heap": {
        "default": true,
        "description": "Take a heap snapshot where supported (Node). Set false for metrics only.",
        "type": "boolean"
      },
      "window_s": {
        "default": 3,
        "description": "Sample RSS over this many seconds",
        "type": "integer",
        "minimum": 0,
        "maximum": 30
      }
    },
    "required": [
      "session_id",
      "heap",
      "window_s"
    ],
    "additionalProperties": false
  },
  "diff_runs": {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "type": "object",
    "properties": {
      "session_id": {
        "type": "string",
        "minLength": 1
      },
      "a": {
        "type": "string",
        "minLength": 1,
        "description": "run id of the earlier result"
      },
      "b": {
        "type": "string",
        "minLength": 1,
        "description": "run id of the later result"
      }
    },
    "required": [
      "session_id",
      "a",
      "b"
    ],
    "additionalProperties": false
  },
  "container_info": {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "type": "object",
    "properties": {
      "session_id": {
        "type": "string",
        "minLength": 1
      }
    },
    "required": [
      "session_id"
    ],
    "additionalProperties": false
  },
  "report": {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "type": "object",
    "properties": {
      "session_id": {
        "type": "string",
        "minLength": 1
      },
      "out": {
        "description": "Optional path to also write the markdown to",
        "type": "string"
      }
    },
    "required": [
      "session_id"
    ],
    "additionalProperties": false
  }
}
```

<!-- schemas:end -->
