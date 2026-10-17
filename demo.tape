# Render with: vhs demo.tape   (https://github.com/charmbracelet/vhs)
Output docs/demo.gif
Set Shell "bash"
Set FontSize 15
Set Width 1400
Set Height 820
Set Theme "Catppuccin Mocha"
Set TypingSpeed 40ms

Type "cd examples/leaky-node && node server.js & sleep 1"
Enter
Sleep 1.5s
Type "S=$(dea attach $! --json | jq -r .session_id); echo $S"
Enter
Sleep 1.5s
Type "dea memory --session $S"
Enter
Sleep 4s
Type "node load.js 300 3"
Enter
Sleep 6s
Type "dea memory --session $S"
Enter
Sleep 4s
Type "dea diff --session $S snapshot_memory#2 snapshot_memory#3"
Enter
Sleep 5s
Type "dea profile --session $S --duration 5 & node load.js 0 6"
Enter
Sleep 9s
Type "dea report --session $S | head -30"
Enter
Sleep 6s
Type "dea detach --session $S"
Enter
Sleep 3s
