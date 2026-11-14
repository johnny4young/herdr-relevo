// What a Claude session hands the processes it starts. A Herdr core started from inside one passes them on to every
// terminal: an agent would take that session's account folder, and a child-session marker turns its transcript off.
export const PARENT_SESSION = ["CLAUDECODE", "CLAUDE_PID", "CLAUDE_CONFIG_DIR", "CLAUDE_EFFORT", "CLAUDE_PLUGIN_DATA",
  "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_CODE_EXECPATH", "CLAUDE_CODE_SESSION_ID", "CLAUDE_CODE_CHILD_SESSION",
  "CLAUDE_CODE_SESSION_ATTENDED", "CLAUDE_CODE_MESSAGING_SOCKET", "CLAUDE_CODE_MESSAGING_TOKEN"];

// The person's login shell runs `script`, without those; their own shell files can still set any of them.
export const shellArgv = (script, ...args) => ["/usr/bin/env", ...PARENT_SESSION.flatMap((name) => ["-u", name]),
  "zsh", "-ilc", script, ...(args.length ? ["zsh", ...args] : [])];
