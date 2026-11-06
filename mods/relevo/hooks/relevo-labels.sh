#!/bin/bash
# shellcheck disable=SC2016 # jq programs, not shell expansions

# Optional Claude Code hook for Relevo. It only sets terminal labels; setup is in HOOK.md.
#
# As a hook (SessionStart, Stop, SessionEnd) it reads Claude's JSON on stdin and sets agent.account, agent.jira,
# agent.transcript, agent.wait and agent.bg. Outside a Herdr terminal it does nothing.
# --check, --install and --uninstall manage it in the settings of each account in config.js. Needs jq.

jq=jq
command -v jq >/dev/null || jq=/usr/bin/jq

# The real script and the mod's config.js beside its hooks folder; only what reads them pays for this.
locate() {
  local link
  script=$0
  while [ -L "$script" ]; do
    link=$(readlink "$script")
    case $link in /*) script=$link ;; *) script=$(dirname "$script")/$link ;; esac
  done
  script="$(cd "$(dirname "$script")" && pwd -P)/$(basename "$script")"
  config="${script%/hooks/*}/config.js"
}

# {claudeDir: account key} pairs from config.js, so a launcher's settings folder names its account.
ACCOUNTS='[scan("key:\\s*\"([^\"]+)\"[^{}]*?claudeDir:\\s*\"([^\"]+)\"")]'

on_hook() {
  [ -n "${HC_TERMINAL_ID:-}" ] || return 0
  local input hc end
  IFS= read -r -d "" input
  hc=hc
  command -v hc >/dev/null || hc=$HOME/.local/bin/hc
  end='"hook_event_name"[[:space:]]*:[[:space:]]*"SessionEnd"'
  if [[ $input =~ $end ]]; then
    "$hc" label "$HC_TERMINAL_ID" agent.wait= agent.bg= agent.account= agent.jira= agent.transcript= >/dev/null 2>&1
    return 0
  fi
  locate
  local dir=${CLAUDE_CONFIG_DIR:-$HOME/.claude} out wait bg account cwd transcript branch jira=""
  dir=${dir%/}
  # Counts background tasks by type, most first, ties in the order they came.
  out=$("$jq" -r --arg rel "${dir#"$HOME"/}" --rawfile cfg "$config" '
    def plural($n; $w): "\($n) \($w)\(if $n == 1 then "" else "s" end)";
    (.background_tasks // []) as $t | (.session_crons // []) as $c
    | (if ($t | length) > 0 then
        ["watch", "⧗ " + ([$t[] | if (.type // "") == "" then "task" else .type | tostring end]
          | reduce .[] as $k ([]; if any(.[]; .[1] == $k) then map(if .[1] == $k then [.[0] + 1, .[1]] else . end)
              else . + [[1, $k]] end)
          | sort_by(-.[0]) | map(plural(.[0]; .[1])) | join(" · "))]
      elif ($c | length) > 0 then ["timer", "⏰ " + plural($c | length; "wakeup")]
      else ["", ""] end)
    + [($cfg | '"$ACCOUNTS"' | map(select(.[1] == $rel)) | last | .[0] // ""), .cwd // "", .transcript_path // ""]
    | .[]' <<<"$input" 2>/dev/null) || return 0
  { IFS= read -r wait; IFS= read -r bg; IFS= read -r account; IFS= read -r cwd; IFS= read -r transcript; } <<<"$out"
  branch=$(git -C "${cwd:-$PWD}" branch --show-current 2>/dev/null)
  local ticket='(^|[^A-Za-z0-9_])([A-Z][A-Z0-9]+-[0-9]+)([^A-Za-z0-9_]|$)'
  [[ $branch =~ $ticket ]] && jira=${BASH_REMATCH[2]}
  "$hc" label "$HC_TERMINAL_ID" "agent.wait=$wait" "agent.bg=$bg" "agent.account=$account" "agent.jira=$jira" \
    "agent.transcript=$transcript" >/dev/null 2>&1
  return 0
}

quote() {
  if [[ $1 =~ ^[A-Za-z0-9@%+=:,./_-]+$ ]]; then printf '%s' "$1"
  else printf "'%s'" "${1//\'/\'\"\'\"\'}"; fi
}

# Exits 0 whatever happens: on Stop a hook's exit 2 stops the agent from finishing.
command_line() {
  local path
  path=$(quote "$script")
  printf '[ -f %s ] && bash %s || true' "$path" "$path"
}

# Only commands this script wrote count as ours; anything else that mentions it stays.
read -r -d '' MANAGE <<'JQ' || true
  def events: ["SessionStart", "Stop", "SessionEnd"];
  def tok: "('[^']*'|[^\\s'\"]+)";
  def ourfile: (if startswith("'") then .[1:-1] else . end) | split("/") | last | test("^relevo-labels\\.sh$");
  def generated: (.command // "") as $c
    | ([$c | capture("^\\s*\\[\\s+-f\\s+(?<a>" + tok + ")\\s+\\]\\s+&&\\s+bash\\s+(?<b>" + tok + ")\\s+\\|\\|\\s+true\\s*$")?
        | select(.a == .b) | .a | ourfile] | any);
  def mentions: test("relevo-labels\\.sh");
  def entries($e): [(.hooks // {})[$e] // [] | .[] | (.hooks // [])[] | select(generated)];
  def installed: . as $s | all(events[]; . as $e | ($s | [entries($e)[].command]) == [$cmd]);
  def outdated: (installed | not) and (. as $s | any(events[]; . as $e | $s | entries($e) | length > 0));
  def add_ours:
    .hooks = (.hooks // {})
    | reduce events[] as $e (.;
        (reduce (.hooks[$e] // [])[] as $g ({found: false, groups: []};
          (reduce ($g.hooks // [])[] as $h ({found: .found, kept: []};
            if ($h | generated) then (if .found then . else .found = true | .kept += [$h | .command = $cmd] end)
            else .kept += [$h] end)) as $r
          | .found = $r.found | if ($r.kept | length) > 0 then .groups += [$g | .hooks = $r.kept] else . end)) as $r
        | .hooks[$e] = $r.groups + (if $r.found then [] else [{hooks: [{type: "command", command: $cmd}]}] end));
  def remove_ours:
    if .hooks == null then . else
      reduce events[] as $e (.;
        [(.hooks[$e] // [])[] | .hooks = [(.hooks // [])[] | select((.command // "") | mentions | not)]
          | select(.hooks | length > 0)] as $gs
        | if ($gs | length) > 0 then .hooks[$e] = $gs else del(.hooks[$e]) end)
      | if (.hooks | length) == 0 then del(.hooks) else . end
    end;
JQ

real_path() {
  local p=$1 link
  while [ -L "$p" ]; do
    link=$(readlink "$p")
    case $link in /*) p=$link ;; *) p=$(dirname "$p")/$link ;; esac
  done
  printf '%s' "$p"
}

# Backs up, then replaces the real file atomically, so a symlinked settings.json stays linked.
save() {
  local real tmp
  real=$(real_path "$1")
  [ -e "$real" ] && cp -p "$real" "$real.relevo-backup-$(date +%s)"
  tmp=$(mktemp "$(dirname "$real")/.relevo-settings-XXXXXX") || return 1
  [ -e "$real" ] && cp -p "$real" "$tmp"
  printf '%s\n' "$2" >"$tmp" && mv "$tmp" "$real"
}

# Runs --check, --install or --uninstall on each account. Never prints settings; returns the exit code.
manage() {
  local action=$1 code=0 cmd folder key root path settings has old state
  locate
  command -v "$jq" >/dev/null || { echo "relevo-labels: needs jq (brew install jq)" >&2; return 1; }
  cmd=$(command_line)
  while IFS=$'\t' read -r folder key; do
    root="$HOME/$folder"
    path="$root/settings.json"
    if [ ! -d "$root" ]; then
      echo "$key ($folder): no such folder, skipped"
      continue
    fi
    if [ -e "$path" ]; then
      if ! "$jq" -e 'type == "object"' "$path" >/dev/null 2>&1; then
        echo "$key ($folder): settings.json is not valid JSON, left as it is"
        code=1
        continue
      fi
      settings=$(cat "$path")
    else
      settings='{}'
    fi
    read -r has old < <("$jq" -r --arg cmd "$cmd" "$MANAGE"' "\(installed) \(outdated)"' <<<"$settings")
    if [ "$action" = --install ] && [ "$has" != true ]; then
      save "$path" "$("$jq" --arg cmd "$cmd" "$MANAGE add_ours" <<<"$settings")" || code=1
    elif [ "$action" = --uninstall ] \
      && [ "$("$jq" --arg cmd "$cmd" "$MANAGE"' any((.hooks // {})[]; tojson | mentions)' <<<"$settings")" = true ]; then
      save "$path" "$("$jq" --arg cmd "$cmd" "$MANAGE remove_ours" <<<"$settings")" || code=1
    elif [ "$action" = --check ] && [ "$has" != true ]; then
      code=1
    fi
    case $action in
      --install) state=installed ;;
      --uninstall) state=removed ;;
      *) if [ "$has" = true ]; then state=installed; elif [ "$old" = true ]; then state=outdated; else state="not installed"; fi ;;
    esac
    echo "$key ($folder): $state"
  done < <("$jq" -Rrs "$ACCOUNTS"' | map({key: .[1], value: .[0]}) | from_entries | to_entries[] | "\(.key)\t\(.value)"' "$config")
  return $code
}

case ${1:-} in
  --check | --install | --uninstall) manage "$1" ;;
  "") on_hook; exit 0 ;;
  *) exit 2 ;;
esac
