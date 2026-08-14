// Why: local PTYs and the daemon/SSH path must use identical ZDOTDIR discovery;
// small drift here breaks different terminal transports in different ways.

function quotePosixSingle(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

export const SHELL_STARTUP_IDENTITY_MARKER_BLOCK = `if [[ "\${ORCA_SHELL_STARTUP_IDENTITY:-0}" == "1" ]]; then
  unset ORCA_SHELL_STARTUP_IDENTITY
  printf "\\033]777;orca-shell-start:%s\\007" "$$"
fi`

// Why: daemon, local, and relay wrappers must preserve one Bash prompt-hook contract.
export const BASH_PROMPT_COMMAND_COMPOSITION_BLOCK = `__orca_normalize_prompt_command_part() {
  local __orca_value="$1" __orca_output_name="$2" __orca_character __orca_chunk
  local __orca_value_length=\${#1} __orca_suffix_length=0 __orca_backslash_length=0
  local __orca_output_length __orca_scan_start
  while (( __orca_value_length - __orca_suffix_length >= 1024 )); do
    __orca_scan_start=$(( __orca_value_length - __orca_suffix_length - 1024 ))
    __orca_chunk="\${__orca_value:__orca_scan_start:1024}"
    case "$__orca_chunk" in
      *[!$' \\t\\n;']*) break ;;
      *) __orca_suffix_length=$(( __orca_suffix_length + 1024 )) ;;
    esac
  done
  while (( __orca_suffix_length < __orca_value_length )); do
    __orca_character="\${__orca_value: -__orca_suffix_length - 1:1}"
    case "$__orca_character" in
      ' '|$'\\t'|$'\\n'|';') __orca_suffix_length=$(( __orca_suffix_length + 1 )) ;;
      *) break ;;
    esac
  done
  __orca_output_length=$(( \${#__orca_value} - __orca_suffix_length ))
  while (( __orca_output_length - __orca_backslash_length >= 1024 )); do
    __orca_scan_start=$(( __orca_output_length - __orca_backslash_length - 1024 ))
    __orca_chunk="\${__orca_value:__orca_scan_start:1024}"
    case "$__orca_chunk" in
      *[!\\\\]*) break ;;
      *) __orca_backslash_length=$(( __orca_backslash_length + 1024 )) ;;
    esac
  done
  while (( __orca_backslash_length < __orca_output_length )); do
    __orca_character="\${__orca_value:__orca_output_length - __orca_backslash_length - 1:1}"
    [[ "$__orca_character" == '\\' ]] || break
    __orca_backslash_length=$(( __orca_backslash_length + 1 ))
  done
  # Preserve the first separator when an odd backslash run escapes it.
  if (( __orca_suffix_length > 0 && __orca_backslash_length % 2 == 1 )); then
    __orca_suffix_length=$(( __orca_suffix_length - 1 ))
    __orca_backslash_length=0
  fi
  __orca_output_length=$(( \${#__orca_value} - __orca_suffix_length ))
  __orca_value="\${__orca_value:0:__orca_output_length}"
  # Bash 4.0-5.0 scalar prompt evaluation preserves an odd terminal backslash.
  if (( __orca_suffix_length == 0 && (BASH_VERSINFO[0] == 4 || (BASH_VERSINFO[0] == 5 && BASH_VERSINFO[1] == 0)) && __orca_backslash_length % 2 == 1 )); then
    __orca_value="$__orca_value\\\\"
  fi
  printf -v "$__orca_output_name" '%s' "$__orca_value"
}
__orca_restore_prompt_status() {
  return "$1"
}
__orca_run_prompt_command_array() {
  local __orca_exit_code=$? __orca_prompt_part __orca_prompt_index __orca_user_count
  local __orca_final_prompt_command
  local __orca_in_prompt_dispatch=1 __orca_dispatching_user_prompt_command=""
  for __orca_prompt_part in "\${__orca_prompt_command_prefix[@]}"; do
    if (( __orca_exit_code == 0 )); then
      eval "$__orca_prompt_part"
    else
      __orca_restore_prompt_status "$__orca_exit_code" || eval "$__orca_prompt_part"
    fi
  done
  __orca_user_count=\${#__orca_prompt_command_array[@]}
  for (( __orca_prompt_index = 0; __orca_prompt_index + 1 < __orca_user_count; __orca_prompt_index++ )); do
    __orca_prompt_part="\${__orca_prompt_command_array[__orca_prompt_index]}"
    __orca_dispatching_user_prompt_command=1
    if (( __orca_exit_code == 0 )); then
      eval "$__orca_prompt_part"
    else
      __orca_restore_prompt_status "$__orca_exit_code" || eval "$__orca_prompt_part"
    fi
    __orca_dispatching_user_prompt_command=""
  done
  if (( __orca_user_count > 0 )); then
    __orca_prompt_part="\${__orca_prompt_command_array[__orca_user_count - 1]}"
    __orca_final_prompt_command='eval "$__orca_prompt_part"'
    for __orca_prompt_index in "\${!__orca_prompt_command_suffix[@]}"; do
      __orca_final_prompt_command+=$'\\n'"\${__orca_prompt_command_suffix[__orca_prompt_index]}"
    done
    __orca_dispatching_user_prompt_command=1
    if (( __orca_exit_code == 0 )); then
      eval "$__orca_final_prompt_command"
    else
      __orca_restore_prompt_status "$__orca_exit_code" || eval "$__orca_final_prompt_command"
    fi
    __orca_dispatching_user_prompt_command=""
  else
    for __orca_prompt_part in "\${__orca_prompt_command_suffix[@]}"; do
      if (( __orca_exit_code == 0 )); then
        eval "$__orca_prompt_part"
      else
        __orca_restore_prompt_status "$__orca_exit_code" || eval "$__orca_prompt_part"
      fi
    done
  fi
  return "$__orca_exit_code"
}
__orca_normalize_prompt_command() {
  [[ -z "\${__orca_prompt_command_normalized:-}" ]] || return 0
  local __orca_prompt_part
  local -a __orca_normalized=()
  for __orca_prompt_part in "\${PROMPT_COMMAND[@]}"; do
    __orca_normalize_prompt_command_part "$__orca_prompt_part" __orca_prompt_part
    [[ -n "$__orca_prompt_part" ]] && __orca_normalized+=("$__orca_prompt_part")
  done
  __orca_prompt_command_normalized=1
  if (( BASH_VERSINFO[0] > 5 || (BASH_VERSINFO[0] == 5 && BASH_VERSINFO[1] >= 1) )); then
    PROMPT_COMMAND=("\${__orca_normalized[@]}")
  else
    __orca_prompt_command_array=("\${__orca_normalized[@]}")
    __orca_prompt_command_prefix=()
    __orca_prompt_command_suffix=()
    unset PROMPT_COMMAND
    PROMPT_COMMAND=__orca_run_prompt_command_array
  fi
}
__orca_prepend_prompt_command() {
  local command="$1"
  __orca_normalize_prompt_command
  if (( BASH_VERSINFO[0] > 5 || (BASH_VERSINFO[0] == 5 && BASH_VERSINFO[1] >= 1) )); then
    PROMPT_COMMAND=("$command" "\${PROMPT_COMMAND[@]}")
  else
    __orca_prompt_command_prefix=("$command" "\${__orca_prompt_command_prefix[@]}")
  fi
}
__orca_append_prompt_command() {
  local command="$1"
  __orca_normalize_prompt_command
  if (( BASH_VERSINFO[0] > 5 || (BASH_VERSINFO[0] == 5 && BASH_VERSINFO[1] >= 1) )); then
    PROMPT_COMMAND+=("$command")
  else
    __orca_prompt_command_suffix+=("$command")
  fi
}`

export function getZshEnvTemplate(zshDir: string, headerPrefix = ''): string {
  const header = headerPrefix
    ? `Orca ${headerPrefix} zsh shell-ready wrapper`
    : 'Orca zsh shell-ready wrapper'
  return `# ${header}
${SHELL_STARTUP_IDENTITY_MARKER_BLOCK}
# Why: capture the runtime wrapper dir before it is unset below. On WSL this
# file is generated with a Windows path but sourced via /mnt/c, so the baked
# literal is unusable there and ZDOTDIR must be restored from this value.
# Derive it from the file being sourced (%x, zsh's internal script name) rather
# than the env-imported $ZDOTDIR: zsh corrupts environment values whose UTF-8
# bytes fall in its 0x84-0x9D token range (e.g. a non-ASCII Windows username
# such as a Korean login), which would make the self-check below fail and fall
# back to the unusable baked literal, so the user's .zshrc never loads (#8003).
# %x is not subject to that corruption; keep $ZDOTDIR as a fallback for the
# rare shell where %x prompt expansion yields nothing.
_orca_wrapper_zdotdir_self="\${\${(%):-%x}:h}"
if [[ -z "\${_orca_wrapper_zdotdir_self:-}" ]]; then
  _orca_wrapper_zdotdir_self="\${ZDOTDIR:-}"
fi
while [[ "\${_orca_wrapper_zdotdir_self:-}" == */ ]]; do
  _orca_wrapper_zdotdir_self="\${_orca_wrapper_zdotdir_self%/}"
done
_orca_spawn_orig_zdotdir="\${ORCA_ORIG_ZDOTDIR:-}"
_orca_user_zdotdir="\${_orca_spawn_orig_zdotdir:-$HOME}"
_orca_zshenv_source_dir="\${ORCA_ZSHENV_SOURCE_DIR:-$HOME}"
_orca_zshenv_path=""
unset ORCA_ZSHENV_SOURCE_DIR

# Normalize fallback and source roots before reading user .zshenv so nested
# Orca PTYs never source another Orca wrapper recursively.
while [[ "\${_orca_user_zdotdir}" == */ ]]; do
  _orca_user_zdotdir="\${_orca_user_zdotdir%/}"
done
case "\${_orca_user_zdotdir}" in
  ""|*/shell-ready/zsh) _orca_user_zdotdir="$HOME" ;;
esac
while [[ "\${_orca_zshenv_source_dir}" == */ ]]; do
  _orca_zshenv_source_dir="\${_orca_zshenv_source_dir%/}"
done
case "\${_orca_zshenv_source_dir}" in
  ""|*/shell-ready/zsh) _orca_zshenv_source_dir="$HOME" ;;
esac

# Why: source at wrapper top level, not in a function/subshell, so .zshenv
# exports, functions, path/fpath typesets, and zsh options keep normal scope.
unset ZDOTDIR
if [[ -n "\${_orca_zshenv_source_dir:-}" && -f "\${_orca_zshenv_source_dir}/.zshenv" ]]; then
  _orca_zshenv_path="\${_orca_zshenv_source_dir}/.zshenv"
fi
if [[ -n "\${_orca_zshenv_path:-}" ]]; then
  source "\${_orca_zshenv_path}"
fi

_orca_discovered_zdotdir="\${ZDOTDIR:-}"

while [[ "\${_orca_discovered_zdotdir}" == */ ]]; do
  _orca_discovered_zdotdir="\${_orca_discovered_zdotdir%/}"
done

case "\${_orca_discovered_zdotdir}" in
  *[![:space:]]*) ;;
  *) _orca_discovered_zdotdir="" ;;
esac

if [[ -n "\${_orca_discovered_zdotdir}" && ! -d "\${_orca_discovered_zdotdir}" ]]; then
  [[ "\${ORCA_DEBUG:-0}" == "1" ]] && echo "[orca-shell-ready] Discovered ZDOTDIR '\${_orca_discovered_zdotdir}' does not exist, falling back" >&2
  _orca_discovered_zdotdir=""
fi

export ORCA_ORIG_ZDOTDIR="\${_orca_discovered_zdotdir:-\${_orca_user_zdotdir:-$HOME}}"

while [[ "\${ORCA_ORIG_ZDOTDIR}" == */ ]]; do
  ORCA_ORIG_ZDOTDIR="\${ORCA_ORIG_ZDOTDIR%/}"
done

case "\${ORCA_ORIG_ZDOTDIR}" in
  ""|*/shell-ready/zsh) export ORCA_ORIG_ZDOTDIR="$HOME" ;;
esac

# Why: use :- after user .zshenv — a pathological unset under set -u must not
# abort the wrapper; empty falls through to the baked-literal branch.
if [[ -n "\${_orca_wrapper_zdotdir_self:-}" && -f "\${_orca_wrapper_zdotdir_self:-}/.zshenv" ]]; then
  export ZDOTDIR="\${_orca_wrapper_zdotdir_self:-}"
else
  export ZDOTDIR=${quotePosixSingle(zshDir)}
fi
unset _orca_spawn_orig_zdotdir _orca_user_zdotdir _orca_zshenv_source_dir _orca_zshenv_path _orca_discovered_zdotdir _orca_wrapper_zdotdir_self
`
}

export function getZshStartupFileSourceBlock(options: {
  fileName: '.zprofile' | '.zshrc' | '.zlogin'
  homeExpression?: string
  interactiveOnly?: boolean
  skipWhenHomeIsCurrentZdotdir?: boolean
}): string {
  const homeExpression = options.homeExpression ?? '"${ORCA_ORIG_ZDOTDIR:-$HOME}"'
  const checks = [
    options.skipWhenHomeIsCurrentZdotdir ? '"$_orca_home" != "$ZDOTDIR"' : null,
    options.interactiveOnly ? '-o interactive' : null,
    `-f "$_orca_home/${options.fileName}"`
  ].filter(Boolean)

  return `_orca_home=${homeExpression}
case "\${_orca_home%/}" in
  */shell-ready/zsh) _orca_home="$HOME" ;;
esac
if [[ ${checks.join(' && ')} ]]; then
  _orca_wrapper_zdotdir="$ZDOTDIR"
  # Why: user startup files resolve plugin/config paths from their own ZDOTDIR;
  # Orca restores its wrapper dir afterward so zsh still loads wrapper files.
  export ZDOTDIR="$_orca_home"
  source "$_orca_home/${options.fileName}"
  export ZDOTDIR="$_orca_wrapper_zdotdir"
  unset _orca_wrapper_zdotdir
fi
`
}

// Why: zsh precmd fires before zle switches the PTY into line-editing mode,
// so the marker must be emitted from zle-line-init. Registering it through
// add-zle-hook-widget is unsafe: the azhw dispatcher aborts its hook chain
// when an earlier hook exits non-zero, and a pre-existing raw user widget
// (e.g. oh-my-zsh vi-mode without VI_MODE_SET_CURSOR) is preserved as the
// first hook and fails — silently suppressing the marker and stalling every
// startup command on the pre-ready timeout. Instead, own zle-line-init: emit
// the marker first, then chain to whatever widget was installed before.
export function getZshShellReadyMarkerRegistrationBlock(escapedMarker: string): string {
  return `if [[ "\${ORCA_SHELL_READY_MARKER:-0}" == "1" ]]; then
  # Why: capture the prior zle-line-init so the marker chains to it. On a
  # re-source we are already the bound widget, so keep the function captured
  # the first time instead of clobbering it to empty (which would silently
  # drop the user's widget on every prompt after the second source). Only
  # user-defined widgets are chainable as plain functions; builtin/completion
  # forms (rare for zle-line-init) are left unchained.
  if [[ "\${widgets[zle-line-init]:-}" == "user:__orca_prompt_mark" ]]; then
    :
  elif (( \${+widgets[zle-line-init]} )) && [[ "\${widgets[zle-line-init]}" == user:* ]]; then
    __orca_prev_line_init_fn="\${widgets[zle-line-init]#user:}"
  else
    __orca_prev_line_init_fn=""
  fi
  __orca_prompt_mark() {
    printf "${escapedMarker}"
    # Why: call the prior hook as a plain function, not an aliased widget, so
    # $WIDGET stays zle-line-init for add-zle-hook-widget dispatchers.
    if [[ -n "\${__orca_prev_line_init_fn:-}" ]]; then
      "\${__orca_prev_line_init_fn}" "$@"
    fi
  }
  zle -N zle-line-init __orca_prompt_mark
fi
`
}

// Why: fish has no ZDOTDIR-style wrapper dir, so the marker rides `--init-command`
// and fires on fish_prompt — the earliest event fish exposes (STA-3417). Unlike zsh's
// zle-line-init this lands just *before* fish arms `?2004h`, which PostReadyFlushGate
// absorbs. `builtin printf` so a user-defined printf can't silently swallow the marker
// and send every launch to the ready timeout.
export function getFishShellReadyInitCommand(escapedMarker: string): string {
  return `if test "$ORCA_SHELL_READY_MARKER" = 1
  function __orca_shell_ready_marker --on-event fish_prompt
    builtin printf "${escapedMarker}"
    functions -e __orca_shell_ready_marker
  end
end`
}

export function getZshFinalZdotdirRestoreBlock(homeExpression = '"${ORCA_ORIG_ZDOTDIR:-$HOME}"') {
  return `_orca_home=${homeExpression}
case "\${_orca_home%/}" in
  */shell-ready/zsh) _orca_home="$HOME" ;;
esac
# Why: after Orca's last wrapper file has loaded, the interactive shell should
# expose the same ZDOTDIR a normal zsh startup would expose.
export ZDOTDIR="$_orca_home"
unset _orca_home
`
}
