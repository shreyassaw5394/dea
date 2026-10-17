#!/usr/bin/env bash
# Runs inside the dea-lab container (privileged). Exercises every Linux adapter
# against the example apps and copies real tool output into tests/fixtures/.
set -u
cd /dea
export DEA_HOME=/dea/.lab-dea
rm -rf "$DEA_HOME"; mkdir -p "$DEA_HOME"
DEA="node dist/cli.js"
FX=tests/fixtures
log() { printf '\n\033[1;36m### %s\033[0m\n' "$*"; }

log readiness
$DEA readiness

log "start example apps"
(cd examples/leaky-node && PORT=3000 node server.js > /tmp/leaky.log 2>&1 &)
(cd examples/deadlock-py && PORT=5055 python3 app.py > /tmp/deadlock.log 2>&1 &)
(sleep 1000 &) ; sleep 1
NODEPID=$(pgrep -f "node server.js" | head -1); PYPID=$(pgrep -f "python3 app.py" | head -1); SLEEPPID=$(pgrep -x sleep | head -1)
echo "node=$NODEPID python=$PYPID sleep=$SLEEPPID"; cat /tmp/leaky.log /tmp/deadlock.log

# continuous load on the node app for the whole node session (~70s)
(cd examples/leaky-node && for i in $(seq 1 25); do node load.js 60 3 >/dev/null 2>&1; sleep 0.5; done &) 

log "attach node"
S1=$($DEA attach "$NODEPID" --json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).session_id))')
echo "S1=$S1"
log "snapshot_memory #1"; $DEA memory --session "$S1" --window 2
log "trace_syscalls (file,network) 8s"; $DEA trace --session "$S1" --duration 8 --categories file,network
log "profile_cpu 8s"; $DEA profile --session "$S1" --duration 8
log "dump_stacks (node inspector)"; $DEA stacks --session "$S1"
log "inspect_sockets"; $DEA sockets --session "$S1"
log "inspect_files"; $DEA files --session "$S1" --window 2
log "capture_traffic 5s (consent)"; $DEA capture --session "$S1" --duration 5 --consent
log "snapshot_memory #2"; $DEA memory --session "$S1" --window 2
log "diff"; $DEA diff --session "$S1" 2 9
log "report"; $DEA report --session "$S1" --md /tmp/report-node.md | tail -5
$DEA detach --session "$S1" | head -3

log "attach python"
S2=$($DEA attach "$PYPID" --json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).session_id))')
log "py dump_stacks (healthy)"; $DEA stacks --session "$S2"
log "py profile 4s with load"; (for i in $(seq 1 15); do curl -s -m 2 localhost:5055/ >/dev/null; done &) ; (for i in $(seq 1 15); do curl -s -m 2 "localhost:5055/?burn=1" >/dev/null; done &); $DEA profile --session "$S2" --duration 4
log "trigger deadlock"; for i in $(seq 1 12); do curl -s -m 1 localhost:5055/ >/dev/null 2>&1; done; sleep 1
log "py dump_stacks (deadlocked)"; $DEA stacks --session "$S2"
log "py snapshot_memory"; $DEA memory --session "$S2" --window 1
log "py trace 4s"; $DEA trace --session "$S2" --duration 4
$DEA detach --session "$S2" | head -3

log "attach native (sleep) for gdb"
S3=$($DEA attach "$SLEEPPID" --json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).session_id))')
$DEA stacks --session "$S3"
$DEA detach --session "$S3" | head -2

log "copy fixtures"
A1="$DEA_HOME/sessions/$S1/artifacts"; A2="$DEA_HOME/sessions/$S2/artifacts"; A3="$DEA_HOME/sessions/$S3/artifacts"
cp "$A1"/*strace.log "$FX/strace/node-slow.log" 2>/dev/null && echo strace-ok
cp "$A1"/*perf-script.txt "$FX/perf/node-script.txt" 2>/dev/null && echo perf-ok
cp "$A1"/*capture.txt "$FX/tcpdump/node-http.txt" 2>/dev/null && echo tcpdump-ok
cp "$A1"/*lsof-sockets.txt "$FX/lsof/linux-node-sockets-fields.txt" 2>/dev/null && echo lsof-ok
ls -t "$A2"/*pyspy-dump.txt | head -1 | xargs -I{} cp {} "$FX/pyspy/deadlock-dump.txt" && echo pyspy-dump-ok
ls -t "$A2"/*pyspy-dump.txt | tail -1 | xargs -I{} cp {} "$FX/pyspy/healthy-dump.txt"
cp "$A2"/*pyspy-folded.txt "$FX/pyspy/py-folded.txt" 2>/dev/null && echo pyspy-folded-ok
cp "$A2"/*strace.log "$FX/strace/python-deadlock.log" 2>/dev/null
cp "$A3"/*gdb-bt.txt "$FX/gdb/sleep.txt" 2>/dev/null && echo gdb-ok
cp /tmp/report-node.md docs/example-report-leaky-node.md 2>/dev/null
# fixtures are written as root from the container; make them editable on the host
chmod -R a+rwX "$FX" "$DEA_HOME" 2>/dev/null
log done
