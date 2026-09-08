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

- `open_terminal` — Open a native OS terminal window in the project directory (macOS Terminal, Windows `cmd`, Linux `gnome-terminal` / `konsole` / `xterm` fallback)
- `terminal_run` — Run a shell command and return stdout/stderr

Also sets `OPENCODE_TERMINAL=1` and `OPENCODE_WORK_DIR` via `shell.env`.

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
