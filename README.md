# opencode-terminal

Open a real native OS terminal from OpenCode + run dev servers, with auto-detect and background sessions.

Built for [OpenCode plugins](https://opencode.ai/docs/plugins/). Works on macOS, Windows, Linux/WSL.

## Why

- `open_terminal({})` with no args just works — detects `npm run dev`, `mvn spring-boot:run`, `go run .`, etc.
- Opens a **native window** you can see, not hidden output.
- `visibleTyping: true` types the command on screen so viewers follow along.
- Background sessions (`terminal_start/log/send/kill`) for headless servers with full tree-kill, no orphan ports.

## Install

Via npm:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["opencode-terminal"]
}
```

```bash
npm i opencode-terminal
```

Local testing:

```bash
# project-level
cp src/index.ts /path/to/project/.opencode/plugins/terminal.ts

# global
cp src/index.ts ~/.config/opencode/plugins/terminal.ts
```

## Quickstart

Auto-detect and run:

```ts
open_terminal({})
// -> Terminal "dev-server" opened in /proj. Running: pnpm run dev [auto-detected: package.json scripts.dev via pnpm]
```

Two servers, visible typing:

```ts
open_terminal({ command: "./mvnw spring-boot:run", title: "backend", visibleTyping: true })
open_terminal({ command: "pnpm dev", title: "frontend", visibleTyping: true })
```

Check what would run before opening:

```ts
terminal_detect({})
// {"cwd":"/proj","detected":{"command":"pnpm run dev","title":"dev-server","reason":"package.json scripts.dev via pnpm"}}
```

Headless server:

```ts
terminal_start({ command: "npm run dev", name: "web" })
// {"sessionId":"term-...","pid":1234,"cwd":"/proj"}
terminal_log({ sessionId: "term-..." })
terminal_send({ sessionId: "term-...", input: "rs" })
terminal_kill({ sessionId: "term-..." })
```

One-shot:

```ts
terminal_run({ command: "npm test", timeout: 30000 })
```

Close window (kills what runs in it):

```ts
close_terminal({ ref: "win-..." })
close_terminal({ title: "backend", force: true })
```

## Tools

| Tool | What it does |
| ---- | ------------ |
| `open_terminal({ command?, title?, cwd?, visibleTyping?, typeDelay? })` | Open native window. Omit `command` to auto-detect. Returns `ref` + `windowId`. |
| `terminal_detect({ cwd? })` | Return `{command, title, reason}` or `null` without opening anything. |
| `close_terminal({ ref?, windowId?, title?, force? })` | Close window. `ref` preferred, `title` works after restart. |
| `terminal_run({ command, cwd?, env?, timeout?, maxOutput? })` | One-shot run. Returns `{exitCode, timedOut, truncated, stdout, stderr}`. Default 30s timeout. |
| `terminal_start({ command, cwd?, env?, name? })` | Start background session. Returns `{sessionId, pid, cwd}`. |
| `terminal_log({ sessionId, tail? })` | Last N chars of stdout/stderr (default 8000). |
| `terminal_send({ sessionId, input, appendNewline? })` | Write to stdin. |
| `terminal_kill({ sessionId })` | Kill whole process tree (TERM then KILL). |
| `terminal_list()` | List all background sessions. |

Args:

- `open_terminal`: `command` omit to auto-detect, `title` e.g. `dev-server`/`backend`/`frontend`, `cwd` defaults to project dir, `visibleTyping` Linux/X11 via xdotool (falls back to silent), `typeDelay` ms/char default 80, clamped 0-500.
- `close_terminal`: closing sends SIGHUP, so server stops. Linux fully supported, macOS closes by title match, Windows best-effort.

## Auto-detect

Checked in order from `cwd`:

- Node: `package.json` `scripts.dev` → `scripts.start` (pm from `pnpm-lock.yaml`/`yarn.lock`/`bun.lock`), `angular.json`, `next.config.*`, `vite.config.*`
- Deno: `deno.json` → `deno task dev`
- Java: `mvnw`/`pom.xml` → `mn:run` if `micronaut`, `spring-boot:run` if `spring-boot`, else `compile exec:java`. `gradlew`/`build.gradle` → `bootRun` if Spring Boot else `run`
- Python: `manage.py` → `python manage.py runserver`, FastAPI → `uvicorn app:app --reload`, Flask → `flask run`, `app.py`/`main.py` fallback
- Go: `go.mod` → `go run .`
- Rust: `Cargo.toml` → `cargo run`
- Ruby: `Gemfile` + `config.ru` → `rails server`
- PHP: `artisan` → `php artisan serve`, `composer.json` → `php -S localhost:8000`
- Static: `index.html` → `python3 -m http.server 8000`

## Platform support

- macOS: Terminal / iTerm / Ghostty / WezTerm / Kitty / Alacritty via `open -a` + osascript
- Windows: Windows Terminal (`wt`) → `cmd`, `taskkill` for close
- Linux/WSL: `gnome-terminal` / `konsole` / `wezterm` / `alacritty` / `kitty` / `ghostty` / `x-terminal-emulator` / `xterm`, `wmctrl` + `xdotool` for track/close/typing

Requires `DISPLAY` + `xdotool` + `wmctrl` on Linux for `visibleTyping` and window tracking. Without them it still opens silently.

Lifetime:

- Native window = process lifetime. Close window = SIGHUP = server stops.
- `terminal_kill` kills children + grandchildren, not just the shell.
- On opencode exit, running background sessions get best-effort KILL. Opt out with `OPENCODE_TERMINAL_NO_CLEANUP=1`.
- `ref` lives only in the session that opened it. After restart close by `title`.

Sets via `shell.env`: `OPENCODE_TERMINAL=1`, `OPENCODE_WORK_DIR`, `TERM=xterm-256color`.

## Dev

```bash
bun install
bunx tsc --noEmit
# or
npm run typecheck
```

Test detect:

```bash
bun -e '
import { TerminalPlugin } from "./src/index.ts";
const p = await TerminalPlugin({ directory: process.cwd(), $: async () => {} });
console.log(await p.tool["terminal_detect"].execute({}, { directory: process.cwd() }));
'
```

## Publish

```bash
npm login
npm publish --access public
```

## License

MIT — see [LICENSE](./LICENSE).

Copyright (c) 2026 ShivamChavan01. You can use, copy, modify, merge, publish, distribute, sublicense, and sell this software, provided the copyright + license notice is kept. Provided "AS IS", no warranty.
