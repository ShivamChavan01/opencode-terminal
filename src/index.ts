import { type Plugin, tool } from "@opencode-ai/plugin"

// Bun / Node runtime global — avoids needing @types/node for tsc
declare const process: { platform: string }

export const TerminalPlugin: Plugin = async ({ directory, $ }) => {
  return {
    tool: {
      open_terminal: tool({
        description: "Open a native OS terminal window in the project directory",
        args: {},
        async execute(_args, context) {
          const cwd = context?.directory ?? directory
          try {
            if (process.platform === "darwin") {
              await $`open -a Terminal ${cwd}`
            } else if (process.platform === "win32") {
              await $`cmd /c start cmd /k "cd /d ${cwd}"`
            } else {
              // Linux: try common emulators in order
              await $`sh -c ${`gnome-terminal --working-directory="${cwd}" 2>/dev/null || x-terminal-emulator -e "cd ${cwd} && bash" 2>/dev/null || konsole --workdir "${cwd}" 2>/dev/null || xterm -e "cd ${cwd} && bash" 2>/dev/null || echo "No supported terminal emulator found"`}`
            }
            return `Terminal opened in ${cwd}`
          } catch (e) {
            throw new Error(`Failed to open terminal: ${e}`)
          }
        },
      }),

      terminal_run: tool({
        description: "Run a shell command and return stdout/stderr",
        args: {
          command: tool.schema.string().describe("Shell command to run"),
        },
        async execute(args, context) {
          const cwd = context?.directory ?? directory
          const result =
            await $`sh -c ${args.command}`.cwd(cwd).nothrow().text()
          return result
        },
      }),
    },

    "shell.env": async (_input, output) => {
      output.env["OPENCODE_TERMINAL"] = "1"
      output.env["OPENCODE_WORK_DIR"] = directory
    },
  }
}
