# Render with: vhs demo.tape   (https://github.com/charmbracelet/vhs)
# Needs `dea` on PATH: npm i -g dea-agents, or DEA_BIN=<dir containing a dea shim> vhs demo.tape
Output docs/demo.gif
Set Shell "bash"
Set FontSize 14
Set Width 1400
Set Height 900
Set Theme "Catppuccin Mocha"
Set TypingSpeed 35ms

Hide
Type "export PATH=$DEA_BIN:$PATH; cd examples/leaky-node && node server.js > /dev/null 2>&1 & PID=$!; sleep 1; clear"
Enter
Show
Type "# A Node server is leaking memory. Let DEA tell us why, with evidence."
Enter
Sleep 1.5s
Type "S=$(dea attach $PID --json | jq -r .session_id); echo session $S"
Enter
Sleep 2s
Type "dea memory --session $S --window 1"
Enter
Sleep 4s
Type "node load.js 400 2   # 400 requests to /work"
Enter
Sleep 4s
Type "clear; dea memory --session $S --window 1"
Enter
Sleep 4.5s
Type "clear; dea diff --session $S snapshot_memory#2 snapshot_memory#3"
Enter
Sleep 5s
Type "clear; dea detach --session $S"
Enter
Sleep 2.5s
Type "# Array retains 50 MB via Context.retained — the module-level array in server.js. Every claim cites evidence ids."
Enter
Sleep 4s
Hide
Type "kill $PID"
Enter
