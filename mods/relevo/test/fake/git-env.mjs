// Isolate test git processes from host ~/.gitconfig hooks, GPG signing and fsmonitor.
process.env.GIT_CONFIG_GLOBAL = "/dev/null";
process.env.GIT_CONFIG_SYSTEM = "/dev/null";
process.env.GIT_CONFIG_NOSYSTEM = "1";
process.env.GIT_ATTR_NOSYSTEM = "1";
