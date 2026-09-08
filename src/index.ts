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

export const TerminalPlugin: Plugin = async ({ directory, $ }) => {
  const sessions = new Map<string, Session>()
  let counter = 0

  const resolveCwd = (context: any, override?: string) =>
    override ?? context?.directory ?? directory

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
          "Open a native OS terminal window in the project directory. Supports macOS Terminal/iTerm/Ghostty/WezTerm/Kitty/Alacritty, Windows Terminal/cmd, Linux gnome-terminal/konsole/wezterm/alacritty/kitty/ghostty/xterm.",
        args: {
          command: tool.schema
            .string()
            .optional()
            .describe("Optional command to run in the new terminal"),
        },
        async execute(args, context) {
          const cwd = resolveCwd(context)
          const cmd = args.command?.trim() ?? ""
          try {
            if (process.platform === "darwin") {
              // macOS: prefer Terminal.app, fall back through popular emulators
              if (cmd) {
                await $`sh -c ${`open -a Terminal "${cwd}" || open -a iTerm "${cwd}" || open -a Ghostty "${cwd}" || open -a WezTerm "${cwd}" || open -a Kitty "${cwd}" || open -a Alacritty "${cwd}"`}`
              } else {
                await $`sh -c ${`open -a Terminal "${cwd}" || open -a iTerm "${cwd}" || open -a Ghostty "${cwd}" || open -a WezTerm "${cwd}" || open -a Kitty "${cwd}" || open -a Alacritty "${cwd}"`}`
              }
              if (cmd) return `Terminal opened in ${cwd}. Run manually: ${cmd}`
              return `Terminal opened in ${cwd}`
            } else if (process.platform === "win32") {
              // Windows: prefer Windows Terminal (wt), fall back to cmd. Handles WSL-style cwd via cd /d.
              if (cmd) {
                await $`cmd /c ${`wt -d "${cwd}" cmd /k "${cmd.replace(/"/g, "'")}" || start cmd /k "cd /d ${cwd} && ${cmd}"`}`
              } else {
                await $`cmd /c ${`wt -d "${cwd}" || start cmd /k "cd /d ${cwd}"`}`
              }
              return `Terminal opened in ${cwd}`
            } else {
              // Linux (+WSL): try emulators in order. ${cwd} may be a /mnt/... WSL path — passed through as-is.
              const inner = cmd
                ? `cd "${cwd}" && exec bash -c "${cmd.replace(/"/g, '\\"')}; exec bash"`
                : `cd "${cwd}" && exec bash`
              await $`sh -c ${[
                `gnome-terminal --working-directory="${cwd}" ${cmd ? `-- bash -c "${cmd.replace(/"/g, '\\"')}; exec bash"` : ""} 2>/dev/null`,
                `konsole --workdir "${cwd}" ${cmd ? `-e bash -c "${cmd.replace(/"/g, '\\"')}; exec bash"` : ""} 2>/dev/null`,
                `wezterm start --cwd "${cwd}" ${cmd ? `bash -c "${cmd.replace(/"/g, '\\"')}; exec bash"` : ""} 2>/dev/null`,
                `alacritty --working-directory "${cwd}" ${cmd ? `-e bash -c "${inner.replace(/"/g, '\\"')}"` : ""} 2>/dev/null`,
                `kitty --directory "${cwd}" ${cmd ? `bash -c "${cmd.replace(/"/g, '\\"')}; exec bash"` : "bash"} 2>/dev/null`,
                `ghostty --working-directory="${cwd}" ${cmd ? `-e "bash -c '${cmd.replace(/'/g, "'\\''")}; exec bash'"` : ""} 2>/dev/null`,
                `x-terminal-emulator -e "bash -c '${inner.replace(/'/g, "'\\''")}'" 2>/dev/null`,
                `xterm -e "bash -c '${inner.replace(/'/g, "'\\''")}'" 2>/dev/null`,
                `echo "No supported terminal emulator found"`,
              ].join(" || ")}`
              return `Terminal opened in ${cwd}`
            }
          } catch (e) {
            throw new Error(`Failed to open terminal: ${e}`)
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
        description: "Kill a background session.",
        args: {
          sessionId: tool.schema.string().describe("Session id from terminal_start"),
        },
        async execute(args) {
          const s = sessions.get(args.sessionId)
          if (!s) throw new Error(`Unknown session: ${args.sessionId}`)
          try {
            s.proc.kill()
          } catch {}
          s.status = "killed"
          return `Killed ${args.sessionId}`
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
