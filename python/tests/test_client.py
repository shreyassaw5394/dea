import json
import subprocess
import sys
from unittest import mock

import pytest

from dea_agents import DEA, DEAError, TOOLS
from dea_agents._specs import SPECS, REQUIRED, json_schema


def test_specs_cover_every_tool():
    assert set(SPECS) == set(TOOLS)
    for t in TOOLS:
        assert json_schema(t)["type"] == "object"
    assert REQUIRED["capture_traffic"] == ["session_id", "consent"]


def test_call_builds_json_args_and_parses_result():
    fake = subprocess.CompletedProcess(args=[], returncode=0, stdout=json.dumps({"ok": True, "tool": "readiness", "findings": [], "evidence": []}), stderr="")
    with mock.patch("subprocess.run", return_value=fake) as run:
        r = DEA(command=["dea"]).call("trace_syscalls", session_id="s", duration_s=5, categories=None)
    assert r["ok"] is True
    argv = run.call_args[0][0]
    assert argv[:3] == ["dea", "call", "trace_syscalls"]
    assert json.loads(argv[3]) == {"session_id": "s", "duration_s": 5}


def test_unknown_tool_rejected():
    with pytest.raises(DEAError):
        DEA(command=["dea"]).call("rm_rf")


def test_attach_returns_session_id():
    fake = subprocess.CompletedProcess(args=[], returncode=0, stdout=json.dumps({"ok": True, "session_id": "abc"}), stderr="")
    with mock.patch("subprocess.run", return_value=fake):
        assert DEA(command=["dea"]).attach(123) == "abc"


def test_missing_node_gives_helpful_error():
    with mock.patch("subprocess.run", side_effect=FileNotFoundError()):
        with pytest.raises(DEAError, match="Node.js"):
            DEA(command=["definitely-not-here"]).readiness()


@pytest.mark.skipif(sys.platform == "win32", reason="not supported")
def test_findings_formatter():
    r = {"findings": [{"severity": "high", "summary": "x", "confidence": "observed", "evidence_ids": ["e1"]}]}
    assert DEA.findings(r) == ["[high] x (observed; e1)"]
