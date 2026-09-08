# opencode-terminal

Open native OS terminal + run shell commands for [OpenCode](https://opencode.ai/docs/plugins/).

## Install

Add to your `opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["opencode-terminal"]
}
```

Or install locally for testing:

```bash
# project-level
cp src/index.ts /path/to/project/.opencode/plugins/terminal.ts

# global
cp src/index.ts ~/.config/opencode/plugins/terminal.ts
```

## Tools

- `open_terminal({ command?, title?, visibleTyping?, typeDelay? })` — Open native window in project dir. macOS: Terminal/iTerm/Ghostty/WezTerm/Kitty/Alacritty. Windows: Windows Terminal (`wt`) → cmd. Linux/WSL: gnome-terminal/konsole/wezterm/alacritty/kitty/ghostty/xterm. `visibleTyping: true` (Linux/X11 via xdotool) visibly types the command keystroke-by-keystroke. Returns a `ref` for closing.
- `close_terminal({ ref?, windowId?, title?, force? })` — Close a native window opened via `open_terminal`. Closing the window stops whatever runs in it (SIGHUP). Refs live only in the session that opened them — after a restart, close by `title`.
- `terminal_run({ command, cwd?, env?, timeout?, maxOutput? })` — One-shot run. Returns JSON `{ exitCode, timedOut, truncated, stdout, stderr }`. Default timeout 30s.
- `terminal_start({ command, cwd?, env?, name? })` — Start background session (dev server, watcher, REPL). Returns `{ sessionId, pid, cwd }`.
- `terminal_log({ sessionId, tail? })` — Poll buffered output.
- `terminal_send({ sessionId, input, appendNewline? })` — Write to stdin.
- `terminal_kill({ sessionId })` — Kill a background session and its whole process tree (TERM then KILL), so kill the terminal = stop the server. `terminal_list()` — Manage sessions.

Also sets `OPENCODE_TERMINAL=1`, `OPENCODE_WORK_DIR`, `TERM=xterm-256color` via `shell.env`.

## Dev

```bash
bun install
bunx tsc --noEmit
```

## Publish

```bash
npm login
npm publish --access public
```

## License

MIT
