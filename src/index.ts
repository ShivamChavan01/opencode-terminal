import { type Plugin, tool } from "@opencode-ai/plugin"

// Runtime globals — avoids needing @types/node / bun-types for tsc
declare const Bun: any
declare const process: { platform: string; env: Record<string, string> }

const MAX_STORE = 200_000 // chars kept per stream per session
const DEFAULT_MAX_OUTPUT = 30_000

type SessionStatus = "running" | "exited" | "killed"

interface Session {
  id: string
  name: string
  command: string
  cwd: string
  pid?: number
  proc: any
  stdout: string
  stderr: string
  truncated: boolean
  startedAt: number
  status: SessionStatus
  exitCode?: number
}

function appendCapped(current: string, add: string): { text: string; truncated: boolean } {
  const next = current + add
  if (next.length <= MAX_STORE) return { text: next, truncated: false }
  return { text: next.slice(next.length - MAX_STORE), truncated: true }
}

function startPump(stream: any, onData: (s: string) => void) {
  if (!stream?.getReader) return
  ;(async () => {
    try {
      const reader = stream.getReader()
      const decoder = new TextDecoder()
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        if (value) onData(decoder.decode(value, { stream: true }))
      }
    } catch {
      // stream closed / process exited
    }
  })()
}

function shellForPlatform(): string[] {
  // Always run via sh -c so shell syntax works everywhere POSIX.
  // Windows is handled by cmd via Bun.spawn as well (sh may not exist),
  // so callers should prefer terminal_run which picks correctly.
  return ["sh", "-c"]
}

function wmWindowIds(): string[] {
  try {
    const res: any = Bun.spawnSync(["sh", "-c", "wmctrl -l 2>/dev/null || true"])
    const out = new TextDecoder().decode(res.stdout ?? new Uint8Array())
    return out
      .split("\n")
      .map((l: string) => l.trim())
      .filter(Boolean)
      .map((l: string) => l.split(/\s+/)[0])
      .filter(Boolean)
  } catch {
    return []
  }
}

// Visible typing via xdotool --file (avoids shell-quoting issues).
// Returns new window id, or "" when unavailable (caller uses silent launch).
async function openVisibleTyping(
  $: any,
  cwd: string,
  cmd: string,
  winTitle: string,
  typeDelay: number
): Promise<string> {
  try {
    if (!process.env["DISPLAY"]) return ""
    const before = new Set(wmWindowIds())
    const safeTitle = (winTitle || cmd.slice(0, 60) || cwd).replace(/"/g, "")
    await $`sh -c ${[
      `gnome-terminal --working-directory="${cwd}" --title="${safeTitle}" 2>/dev/null`,
      `konsole --workdir "${cwd}" 2>/dev/null`,
      `wezterm start --cwd "${cwd}" 2>/dev/null`,
      `alacritty --working-directory "${cwd}" --title "${safeTitle}" 2>/dev/null`,
      `kitty --directory "${cwd}" --title "${safeTitle}" bash 2>/dev/null`,
      `ghostty --working-directory="${cwd}" 2>/dev/null`,
      `x-terminal-emulator -e bash 2>/dev/null`,
      `xterm -e bash 2>/dev/null`,
    ].join(" || ")}`
    let winId = ""
    for (let i = 0; i < 25; i++) {
      await new Promise((r) => setTimeout(r, 200))
      const fresh = wmWindowIds().filter((id) => !before.has(id))
      if (fresh.length > 0) {
        winId = fresh[fresh.length - 1]
        break
      }
    }
    if (!winId) return ""
    const tmp = `/tmp/opencode-type-${Date.now()}-${Math.floor(Math.random() * 1e6)}.txt`
    try {
      await Bun.write(tmp, cmd)
    } catch {
      return ""
    }
    const escId = winId.replace(/[^0-9a-zA-Zx]/g, "")
    const escTmp = tmp.replace(/"/g, "")
    const escTitle = safeTitle.replace(/'/g, "'\\''")
    await $`sh -c ${`xdotool set_window --name '${escTitle}' ${escId} 2>/dev/null; xdotool windowactivate --sync ${escId} 2>/dev/null; sleep 0.5; xdotool type --delay ${typeDelay} --file "${escTmp}" 2>/dev/null; sleep 0.3; xdotool key Return 2>/dev/null; rm -f "${escTmp}"`}`
    return winId
  } catch {
    return ""
  }
}

function childMap(): Map<number, number[]> {
  const children = new Map<number, number[]>()
  try {
    if (process.platform === "win32") return children
    const res: any = Bun.spawnSync(["sh", "-c", "ps -o pid=,ppid= -ax 2>/dev/null"])
    const out = new TextDecoder().decode(res.stdout ?? new Uint8Array())
    for (const line of out.split("\n")) {
      const parts = line.trim().split(/\s+/)
      if (parts.length < 2) continue
      const pid = Number(parts[0])
      const ppid = Number(parts[1])
      if (!pid || isNaN(pid) || isNaN(ppid)) continue
      const list = children.get(ppid) ?? []
      list.push(pid)
      children.set(ppid, list)
    }
  } catch {}
  return children
}

function descendantPids(rootPid: number): number[] {
  const children = childMap()
  const found: number[] = []
  const stack = [...(children.get(rootPid) ?? [])]
  while (stack.length > 0) {
    const pid = stack.pop()!
    found.push(pid)
    const kids = children.get(pid)
    if (kids) stack.push(...kids)
  }
  return found
}

function signalPidsSync(pids: number[], sig: string) {
  const unique = [...new Set(pids)].filter((p) => p > 0)
  if (unique.length === 0) return
  try {
    if (process.platform === "win32") return
    Bun.spawnSync(["sh", "-c", `kill -${sig} ${unique.join(" ")} 2>/dev/null`])
  } catch {}
}

function alivePids(pids: number[]): number[] {
  const alive: number[] = []
  try {
    if (process.platform === "win32") return pids
    for (const pid of pids) {
      const res: any = Bun.spawnSync(["sh", "-c", `kill -0 ${pid} 2>/dev/null`])
      if (res.exitCode === 0) alive.push(pid)
    }
  } catch {}
  return alive
}

interface OpenedWindow {
  ref: string
  windowId: string
  title: string
  cwd: string
  openedAt: number
}

const openedWindows = new Map<string, OpenedWindow>()
let winCounter = 0

async function findNewWindow(before: Set<string>, timeoutMs = 5000): Promise<string> {
  const steps = Math.max(1, Math.floor(timeoutMs / 200))
  for (let i = 0; i < steps; i++) {
    await new Promise((r) => setTimeout(r, 200))
    const fresh = wmWindowIds().filter((id) => !before.has(id))
    if (fresh.length > 0) return fresh[fresh.length - 1]
  }
  return ""
}

export const TerminalPlugin: Plugin = async ({ directory, $ }) => {
  const sessions = new Map<string, Session>()
  let counter = 0

  const resolveCwd = (context: any, override?: string) =>
    override ?? context?.directory ?? directory

  async function killSessionTree(s: Session) {
    if (s.pid && process.platform === "win32") {
      try {
        Bun.spawnSync(["cmd", "/c", `taskkill /PID ${s.pid} /T /F`])
      } catch {}
    } else if (s.pid) {
      signalPidsSync([s.pid, ...descendantPids(s.pid)], "TERM")
      await new Promise((r) => setTimeout(r, 2000))
      try {
        s.proc.kill()
      } catch {}
      signalPidsSync(alivePids([s.pid, ...descendantPids(s.pid)]), "KILL")
    } else {
      try {
        s.proc.kill()
      } catch {}
    }
    s.status = "killed"
  }

  try {
    const gproc: any = (globalThis as any).process
    gproc?.on?.("exit", () => {
      if ((process.env["OPENCODE_TERMINAL_NO_CLEANUP"] ?? "") !== "") return
      for (const s of sessions.values()) {
        if (s.status !== "running" || !s.pid) continue
        if (process.platform === "win32") {
          try {
            Bun.spawnSync(["cmd", "/c", `taskkill /PID ${s.pid} /T /F`])
          } catch {}
        } else {
          signalPidsSync([s.pid, ...descendantPids(s.pid)], "KILL")
        }
        s.status = "killed"
      }
    })
  } catch {}

  async function runOneShot(
    command: string,
    cwd: string,
    env: Record<string, string> | undefined,
    timeoutMs: number | undefined,
    maxOutput: number
  ) {
    const mergedEnv = { ...process.env, ...(env ?? {}) }
    let proc: any
    if (process.platform === "win32") {
      proc = Bun.spawn(["cmd", "/c", command], {
        cwd,
        env: mergedEnv,
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      })
    } else {
      proc = Bun.spawn([...shellForPlatform(), command], {
        cwd,
        env: mergedEnv,
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      })
    }

    let stdout = ""
    let stderr = ""
    let truncated = false
    const onOut = (s: string) => {
      const r = appendCapped(stdout, s)
      stdout = r.text
      if (r.truncated) truncated = true
    }
    const onErr = (s: string) => {
      const r = appendCapped(stderr, s)
      stderr = r.text
      if (r.truncated) truncated = true
    }
    startPump(proc.stdout, onOut)
    startPump(proc.stderr, onErr)

    let timedOut = false
    let exitCode: number
    if (timeoutMs && timeoutMs > 0) {
      const res = await Promise.race([
        proc.exited.then((c: number) => ({ kind: "exit" as const, code: c })),
        new Promise<{ kind: "timeout" }>((resolve) =>
          setTimeout(() => resolve({ kind: "timeout" }), timeoutMs)
        ),
      ])
      if (res.kind === "timeout") {
        timedOut = true
        try {
          proc.kill()
        } catch {}
        exitCode = (await proc.exited) as number
      } else {
        exitCode = res.code
      }
    } else {
      exitCode = (await proc.exited) as number
    }

    // Give pumps a tick to flush trailing chunks
    await new Promise((r) => setTimeout(r, 50))

    const cut = (s: string) =>
      s.length > maxOutput ? s.slice(s.length - maxOutput) : s
    const wasCut = stdout.length > maxOutput || stderr.length > maxOutput
    return JSON.stringify(
      {
        exitCode,
        timedOut,
        truncated: truncated || wasCut,
        stdout: cut(stdout),
        stderr: cut(stderr),
      },
      null,
      2
    )
  }

  return {
    tool: {
      open_terminal: tool({
        description:
          "Open a native OS terminal window in the project directory. Supports macOS Terminal/iTerm/Ghostty/WezTerm/Kitty/Alacritty, Windows Terminal/cmd, Linux gnome-terminal/konsole/wezterm/alacritty/kitty/ghostty/xterm. Pass command to run it inside; pass visibleTyping=true (Linux/X11) to visibly type the command via xdotool so the user sees keystrokes.",
        args: {
          command: tool.schema
            .string()
            .optional()
            .describe("Optional command to run in the new terminal"),
          title: tool.schema
            .string()
            .optional()
            .describe("Window title (e.g. backend-micronaut)"),
          visibleTyping: tool.schema
            .boolean()
            .optional()
            .describe(
              "Visibly type the command keystroke-by-keystroke (Linux/X11 via xdotool) instead of launching it silently. Falls back to silent launch when xdotool/wmctrl are unavailable."
            ),
          typeDelay: tool.schema
            .number()
            .optional()
            .describe("Ms per character for visible typing (default 80, clamped 0-500)"),
        },
        async execute(args, context) {
          const cwd = resolveCwd(context)
          const cmd = args.command?.trim() ?? ""
          const title = (args as any).title?.trim() ?? ""
          const visibleTyping = (args as any).visibleTyping ?? false
          const rawDelay = Number((args as any).typeDelay ?? 80)
          const typeDelay = Math.max(0, Math.min(500, isNaN(rawDelay) ? 80 : rawDelay))
          const winTitle = title || cmd.slice(0, 60) || cwd
          try {
            if (process.platform === "darwin") {
              if (cmd) {
                const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')
                await $`sh -c ${`osascript -e 'tell application "Terminal" to do script "cd \\"${esc(cwd)}\\" && ${esc(cmd)}"' -e 'tell application "Terminal" to activate' 2>/dev/null || open -a Terminal "${cwd}" || open -a iTerm "${cwd}" || open -a Ghostty "${cwd}" || open -a WezTerm "${cwd}" || open -a Kitty "${cwd}" || open -a Alacritty "${cwd}"`}`
                return `Terminal opened in ${cwd}. Running: ${cmd}`
              }
              await $`sh -c ${`open -a Terminal "${cwd}" || open -a iTerm "${cwd}" || open -a Ghostty "${cwd}" || open -a WezTerm "${cwd}" || open -a Kitty "${cwd}" || open -a Alacritty "${cwd}"`}`
              return `Terminal opened in ${cwd}`
            } else if (process.platform === "win32") {
              // Windows: prefer Windows Terminal (wt), fall back to cmd. Handles WSL-style cwd via cd /d.
              const wtTitle = winTitle.replace(/"/g, "")
              if (cmd) {
                await $`cmd /c ${`wt -d "${cwd}" --title "${wtTitle}" cmd /k "${cmd.replace(/"/g, "'")}" || start cmd /k "cd /d ${cwd} && ${cmd}"`}`
              } else {
                await $`cmd /c ${`wt -d "${cwd}" --title "${wtTitle}" || start cmd /k "cd /d ${cwd}"`}`
              }
              return `Terminal "${winTitle}" opened in ${cwd}`
            } else {
              const trackWindow = (windowId: string) => {
                if (!windowId) return ""
                winCounter += 1
                const ref = `win-${Date.now().toString(36)}-${winCounter}`
                openedWindows.set(ref, {
                  ref,
                  windowId,
                  title: winTitle,
                  cwd,
                  openedAt: Date.now(),
                })
                return ref
              }
              if (cmd && visibleTyping) {
                const winId = await openVisibleTyping($, cwd, cmd, winTitle, typeDelay)
                if (winId) {
                  const ref = trackWindow(winId)
                  return `Terminal "${winTitle}" (${winId}) opened in ${cwd} with visible typing: ${cmd} (ref=${ref})`
                }
              }
              const before = new Set(wmWindowIds())
              const safeTitle = winTitle.replace(/"/g, "")
              const titleFlag = `--title="${safeTitle}" `
              const inner = cmd
                ? `cd "${cwd}" && exec bash -c "${cmd.replace(/"/g, '\\"')}; exec bash"`
                : `cd "${cwd}" && exec bash`
              await $`sh -c ${[
                `gnome-terminal --working-directory="${cwd}" ${titleFlag}${cmd ? `-- bash -c "${cmd.replace(/"/g, '\\"')}; exec bash"` : ""} 2>/dev/null`,
                `konsole --workdir "${cwd}" ${cmd ? `-e bash -c "${cmd.replace(/"/g, '\\"')}; exec bash"` : ""} 2>/dev/null`,
                `wezterm start --cwd "${cwd}" ${cmd ? `bash -c "${cmd.replace(/"/g, '\\"')}; exec bash"` : ""} 2>/dev/null`,
                `alacritty --working-directory "${cwd}" --title "${safeTitle}" ${cmd ? `-e bash -c "${inner.replace(/"/g, '\\"')}"` : ""} 2>/dev/null`,
                `kitty --directory "${cwd}" --title "${safeTitle}" ${cmd ? `bash -c "${cmd.replace(/"/g, '\\"')}; exec bash"` : "bash"} 2>/dev/null`,
                `ghostty --working-directory="${cwd}" ${cmd ? `-e "bash -c '${cmd.replace(/'/g, "'\\''")}; exec bash'"` : ""} 2>/dev/null`,
                `x-terminal-emulator -e "bash -c '${inner.replace(/'/g, "'\\''")}'" 2>/dev/null`,
                `xterm -e "bash -c '${inner.replace(/'/g, "'\\''")}'" 2>/dev/null`,
                `echo "No supported terminal emulator found"`,
              ].join(" || ")}`
              const winId = await findNewWindow(before)
              const ref = trackWindow(winId)
              const tag = ref
                ? ` (ref=${ref}, window=${winId})`
                : " (window not tracked - close it manually)"
              return cmd
                ? `Terminal "${winTitle}" opened in ${cwd}. Running: ${cmd}${tag}`
                : `Terminal "${winTitle}" opened in ${cwd}${tag}`
            }
          } catch (e) {
            throw new Error(`Failed to open terminal: ${e}`)
          }
        },
      }),

      close_terminal: tool({
        description:
          "Close a native OS terminal window opened via open_terminal. Give ref (from open_terminal output), windowId, or title. Closing the window stops whatever runs in it (SIGHUP). Linux/X11 only fully supported; macOS closes by title match, Windows is best-effort.",
        args: {
          ref: tool.schema
            .string()
            .optional()
            .describe("Reference id returned by open_terminal (ref=win-...)"),
          windowId: tool.schema
            .string()
            .optional()
            .describe("Raw window id (e.g. 0x02e2cc54)"),
          title: tool.schema
            .string()
            .optional()
            .describe("Close first window whose title contains this text"),
          force: tool.schema
            .boolean()
            .optional()
            .describe("Force-kill the window instead of polite close (default false)"),
        },
        async execute(args) {
          const force = (args as any).force ?? false
          let windowId = (args as any).windowId?.trim() ?? ""
          let matchedRef = ""
          if (!windowId && (args as any).ref) {
            const rec = openedWindows.get((args as any).ref)
            if (!rec) throw new Error(`Unknown terminal ref: ${(args as any).ref}`)
            windowId = rec.windowId
            matchedRef = rec.ref
          }
          try {
            if (process.platform === "darwin") {
              const title = (args as any).title?.trim() ?? ""
              if (!title && matchedRef) {
                const rec = openedWindows.get(matchedRef)
                if (rec) (args as any).title = rec.title
              }
              const t = ((args as any).title ?? "").trim()
              if (!t) throw new Error("macOS close needs title (or a ref recorded with one)")
              const esc = t.replace(/\\/g, "\\\\").replace(/"/g, '\\"')
              await $`sh -c ${`osascript -e 'tell application "Terminal" to close (every window whose name contains "${esc}")' 2>/dev/null || osascript -e 'tell application "iTerm2" to close (every window whose name contains "${esc}")' 2>/dev/null || echo "no matching window"`}`
              if (matchedRef) openedWindows.delete(matchedRef)
              return `Close requested for terminal(s) matching "${t}"`
            } else if (process.platform === "win32") {
              const t = ((args as any).title ?? "").trim() || openedWindows.get(matchedRef)?.title || ""
              if (!t) throw new Error("Windows close needs title")
              await $`cmd /c ${`taskkill /FI "WINDOWTITLE eq ${t}*" /F`}`
              if (matchedRef) openedWindows.delete(matchedRef)
              return `Close requested for terminal(s) matching "${t}"`
            } else {
              if (!windowId && (args as any).title) {
                const needle = ((args as any).title as string).toLowerCase()
                try {
                  const res: any = Bun.spawnSync([
                    "sh",
                    "-c",
                    "wmctrl -l 2>/dev/null || true",
                  ])
                  const out = new TextDecoder().decode(res.stdout ?? new Uint8Array())
                  for (const line of out.split("\n")) {
                    if (line.toLowerCase().includes(needle)) {
                      const id = line.trim().split(/\s+/)[0]
                      if (id) {
                        windowId = id
                        break
                      }
                    }
                  }
                } catch {}
              }
              if (!windowId) throw new Error("No matching terminal window found (need ref, windowId, or title)")
              const escId = windowId.replace(/[^0-9a-zA-Zx]/g, "")
              await $`sh -c ${force ? `xdotool windowkill ${escId} 2>/dev/null || wmctrl -c ${escId} 2>/dev/null || echo "close failed"` : `xdotool windowclose ${escId} 2>/dev/null || wmctrl -c ${escId} 2>/dev/null || echo "close failed"`}`
              await new Promise((r) => setTimeout(r, 800))
              const gone = !wmWindowIds().includes(windowId)
              if (matchedRef && gone) openedWindows.delete(matchedRef)
              for (const [ref, rec] of openedWindows) {
                if (rec.windowId === windowId && gone) openedWindows.delete(ref)
              }
              return gone
                ? `Terminal ${windowId} closed${matchedRef ? ` (${matchedRef})` : ""}`
                : `Close sent to ${windowId} but window still present - retry with force=true`
            }
          } catch (e) {
            throw new Error(`Failed to close terminal: ${e}`)
          }
        },
      }),

      terminal_run: tool({
        description:
          "Run a one-shot shell command with timeout, cwd/env overrides. Returns JSON { exitCode, timedOut, truncated, stdout, stderr }.",
        args: {
          command: tool.schema.string().describe("Shell command to run"),
          cwd: tool.schema
            .string()
            .optional()
            .describe("Working directory (defaults to project directory)"),
          env: tool.schema
            .record(tool.schema.string(), tool.schema.string())
            .optional()
            .describe("Extra env vars merged over process.env"),
          timeout: tool.schema
            .number()
            .optional()
            .describe("Timeout in ms (default 30000, 0 = no timeout)"),
          maxOutput: tool.schema
            .number()
            .optional()
            .describe("Max chars per stream in output (default 30000)"),
        },
        async execute(args, context) {
          const cwd = resolveCwd(context, args.cwd)
          const timeoutMs = args.timeout ?? 30_000
          const maxOutput = args.maxOutput ?? DEFAULT_MAX_OUTPUT
          return runOneShot(
            args.command,
            cwd,
            args.env as Record<string, string> | undefined,
            timeoutMs === 0 ? undefined : timeoutMs,
            maxOutput
          )
        },
      }),

      terminal_start: tool({
        description:
          "Start a long-running command in background (dev server, watcher, REPL). Returns sessionId. Poll with terminal_log, write with terminal_send.",
        args: {
          command: tool.schema.string().describe("Shell command to start"),
          cwd: tool.schema
            .string()
            .optional()
            .describe("Working directory (defaults to project directory)"),
          env: tool.schema
            .record(tool.schema.string(), tool.schema.string())
            .optional()
            .describe("Extra env vars merged over process.env"),
          name: tool.schema
            .string()
            .optional()
            .describe("Friendly name for terminal_list"),
        },
        async execute(args, context) {
          const cwd = resolveCwd(context, args.cwd)
          const mergedEnv = { ...process.env, ...((args.env ?? {}) as Record<string, string>) }
          const proc =
            process.platform === "win32"
              ? Bun.spawn(["cmd", "/c", args.command], {
                  cwd,
                  env: mergedEnv,
                  stdin: "pipe",
                  stdout: "pipe",
                  stderr: "pipe",
                })
              : Bun.spawn([...shellForPlatform(), args.command], {
                  cwd,
                  env: mergedEnv,
                  stdin: "pipe",
                  stdout: "pipe",
                  stderr: "pipe",
                })
          counter += 1
          const id = `term-${Date.now().toString(36)}-${counter}`
          const session: Session = {
            id,
            name: args.name ?? args.command.slice(0, 40),
            command: args.command,
            cwd,
            pid: proc.pid,
            proc,
            stdout: "",
            stderr: "",
            truncated: false,
            startedAt: Date.now(),
            status: "running",
          }
          sessions.set(id, session)
          startPump(proc.stdout, (s) => {
            const r = appendCapped(session.stdout, s)
            session.stdout = r.text
            if (r.truncated) session.truncated = true
          })
          startPump(proc.stderr, (s) => {
            const r = appendCapped(session.stderr, s)
            session.stderr = r.text
            if (r.truncated) session.truncated = true
          })
          ;(async () => {
            try {
              const code = (await proc.exited) as number
              session.exitCode = code
              if (session.status === "running") session.status = "exited"
            } catch {
              if (session.status === "running") session.status = "exited"
            }
          })()
          return JSON.stringify({ sessionId: id, pid: proc.pid, cwd }, null, 2)
        },
      }),

      terminal_log: tool({
        description: "Read buffered output of a background session.",
        args: {
          sessionId: tool.schema.string().describe("Session id from terminal_start"),
          tail: tool.schema
            .number()
            .optional()
            .describe("Last N chars per stream (default 8000)"),
        },
        async execute(args) {
          const s = sessions.get(args.sessionId)
          if (!s) throw new Error(`Unknown session: ${args.sessionId}`)
          const tail = args.tail ?? 8000
          const cut = (t: string) => (t.length > tail ? t.slice(t.length - tail) : t)
          return JSON.stringify(
            {
              sessionId: s.id,
              name: s.name,
              command: s.command,
              cwd: s.cwd,
              pid: s.pid,
              status: s.status,
              exitCode: s.exitCode,
              truncated: s.truncated,
              stdout: cut(s.stdout),
              stderr: cut(s.stderr),
            },
            null,
            2
          )
        },
      }),

      terminal_send: tool({
        description: "Send stdin input to a running background session (e.g. commands for a REPL / dev server).",
        args: {
          sessionId: tool.schema.string().describe("Session id from terminal_start"),
          input: tool.schema.string().describe("Text to write to stdin (newline appended if missing and appendNewline !== false)"),
          appendNewline: tool.schema
            .boolean()
            .optional()
            .describe("Append \\n if missing (default true)"),
        },
        async execute(args) {
          const s = sessions.get(args.sessionId)
          if (!s) throw new Error(`Unknown session: ${args.sessionId}`)
          if (s.status !== "running") throw new Error(`Session ${args.sessionId} is ${s.status}`)
          const appendNl = args.appendNewline ?? true
          let text = args.input
          if (appendNl && !text.endsWith("\n")) text += "\n"
          try {
            s.proc.stdin.write(text)
            s.proc.stdin.flush()
          } catch (e) {
            throw new Error(`Failed to write to ${args.sessionId}: ${e}`)
          }
          return `Sent ${text.length} chars to ${args.sessionId}`
        },
      }),

      terminal_kill: tool({
        description: "Kill a background session and its whole process tree.",
        args: {
          sessionId: tool.schema.string().describe("Session id from terminal_start"),
        },
        async execute(args) {
          const s = sessions.get(args.sessionId)
          if (!s) throw new Error(`Unknown session: ${args.sessionId}`)
          const tree = s.pid ? [s.pid, ...descendantPids(s.pid)] : []
          await killSessionTree(s)
          const leftover = s.pid ? alivePids([s.pid, ...descendantPids(s.pid)]) : []
          const stopped = tree.length - leftover.length
          return `Killed ${args.sessionId} (${stopped} process(es) stopped${leftover.length > 0 ? `, still alive: ${leftover.join(",")}` : ""})`
        },
      }),

      terminal_list: tool({
        description: "List all background terminal sessions.",
        args: {},
        async execute() {
          return JSON.stringify(
            [...sessions.values()].map((s) => ({
              sessionId: s.id,
              name: s.name,
              command: s.command,
              cwd: s.cwd,
              pid: s.pid,
              status: s.status,
              exitCode: s.exitCode,
              startedAt: new Date(s.startedAt).toISOString(),
              stdoutBytes: s.stdout.length,
              stderrBytes: s.stderr.length,
            })),
            null,
            2
          )
        },
      }),
    },

    "shell.env": async (_input, output) => {
      output.env["OPENCODE_TERMINAL"] = "1"
      output.env["OPENCODE_WORK_DIR"] = directory
      output.env["TERM"] = output.env["TERM"] ?? "xterm-256color"
    },
  }
}
