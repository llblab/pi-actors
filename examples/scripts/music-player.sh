#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat >&2 <<'USAGE'
Usage:
  music-player.sh play <source-file-dir-url-playlist-or-list> [loop=true] [volume=70] [player=auto] [state-dir] [event-delivery=log]
  music-player.sh <pause|resume|toggle|next|previous|stop|status> <state-dir>
  music-player.sh control <state-dir> <play|pause|toggle|next|previous|stop|status>

Runs a small foreground music player so pi-auto-tools can own it as an async run.
Control messages are newline-delimited commands written to <state-dir>/control.fifo.
Use async_run action=send run_id=<run> message=<command>, or direct control commands below.
Supported players: auto, mpv, ffplay, cvlc, play.
USAGE
}

have() { command -v "$1" >/dev/null 2>&1; }

expand_path() {
  local value="$1"
  case "$value" in
    "~") printf '%s\n' "$HOME" ;;
    "~/"*) printf '%s\n' "$HOME/${value#~/}" ;;
    *) printf '%s\n' "$value" ;;
  esac
}

is_url() {
  [[ "$1" =~ ^[A-Za-z][A-Za-z0-9+.-]*:// ]]
}

json_escape() {
  local value="$1"
  value=${value//\\/\\\\}
  value=${value//\"/\\\"}
  value=${value//$'\n'/\\n}
  printf '%s' "$value"
}

normalize_delivery() {
  case "${1,,}" in
    log|notify|followup) printf '%s\n' "${1,,}" ;;
    *) echo "music-player: invalid event delivery: $1" >&2; exit 2 ;;
  esac
}

emit_track_event() {
  local index="$1"
  local count="$2"
  local track="$3"
  local player_name="$4"
  local title
  local ts
  title=$(basename "$track")
  ts=$(date -Iseconds)
  cat >>"$event_file" <<JSON
{"event":"player.track","summary":"Now playing: $(json_escape "$title")","level":"info","delivery":"$(json_escape "$event_delivery")","ts":"$(json_escape "$ts")","data":{"track":"$(json_escape "$track")","index":$index,"count":$count,"player":"$(json_escape "$player_name")"}}
JSON
}

write_status() {
  local state="$1"
  local index="$2"
  local count="$3"
  local track="$4"
  local player_name="$5"
  local pid_value="${6:-}"
  local updated_at
  updated_at=$(date -Iseconds)
  cat >"$status_file" <<STATUS
state=$state
index=$index
count=$count
track=$track
player=$player_name
pid=$pid_value
updated_at=$updated_at
STATUS
  cat >"$status_json_file" <<JSON
{"state":"$(json_escape "$state")","index":$index,"count":$count,"track":"$(json_escape "$track")","player":"$(json_escape "$player_name")","pid":"$(json_escape "$pid_value")","updated_at":"$(json_escape "$updated_at")"}
JSON
}

parse_bool() {
  case "${1,,}" in
    1|true|yes|y|on) printf 'true\n' ;;
    0|false|no|n|off) printf 'false\n' ;;
    *) echo "music-player: invalid loop value: $1" >&2; exit 2 ;;
  esac
}

normalize_volume() {
  local value="$1"
  if [[ ! "$value" =~ ^[0-9]+$ ]]; then
    echo "music-player: volume must be an integer 0..100" >&2
    exit 2
  fi
  if (( value > 100 )); then value=100; fi
  printf '%s\n' "$value"
}

select_player() {
  local requested="$1"
  local selected="$requested"
  if [[ "$selected" == "auto" ]]; then
    for candidate in mpv ffplay cvlc play; do
      if have "$candidate"; then
        selected="$candidate"
        break
      fi
    done
  fi
  case "$selected" in
    mpv|ffplay|cvlc|play) ;;
    *) echo "music-player: unsupported player: $requested" >&2; exit 2 ;;
  esac
  if ! have "$selected"; then
    echo "music-player: player not found: $selected" >&2
    exit 127
  fi
  printf '%s\n' "$selected"
}

add_track() {
  local item
  item=$(expand_path "$1")
  [[ -z "$item" ]] && return 0
  if is_url "$item" || [[ -e "$item" ]]; then
    tracks+=("$item")
    return 0
  fi
  echo "music-player: source entry not found: $item" >&2
}

load_playlist() {
  local source_arg
  source_arg=$(expand_path "$1")
  tracks=()
  if [[ "$source_arg" == *"|"* ]]; then
    local old_ifs="$IFS"
    IFS='|'
    read -r -a split_tracks <<<"$source_arg"
    IFS="$old_ifs"
    for item in "${split_tracks[@]}"; do add_track "$item"; done
  elif is_url "$source_arg"; then
    tracks+=("$source_arg")
  elif [[ -d "$source_arg" ]]; then
    while IFS= read -r -d '' file; do
      tracks+=("$file")
    done < <(find "$source_arg" -type f \( -iname '*.mp3' -o -iname '*.ogg' -o -iname '*.wav' -o -iname '*.flac' -o -iname '*.m4a' \) -print0 | sort -z)
  elif [[ -f "$source_arg" && ( "$source_arg" == *.m3u || "$source_arg" == *.m3u8 || "$source_arg" == *.txt ) ]]; then
    local base_dir
    base_dir=$(cd "$(dirname "$source_arg")" && pwd)
    while IFS= read -r line || [[ -n "$line" ]]; do
      line="${line%$'\r'}"
      [[ -z "$line" || "$line" == \#* ]] && continue
      if is_url "$line" || [[ "$line" = /* || "$line" == ~* ]]; then
        add_track "$line"
      else
        add_track "$base_dir/$line"
      fi
    done <"$source_arg"
  elif [[ -e "$source_arg" ]]; then
    tracks+=("$source_arg")
  else
    echo "music-player: source not found: $source_arg" >&2
    exit 66
  fi
  if (( ${#tracks[@]} == 0 )); then
    echo "music-player: source has no playable tracks: $source_arg" >&2
    exit 66
  fi
}

player_command() {
  local player_name="$1"
  local volume_value="$2"
  local track="$3"
  case "$player_name" in
    mpv)
      cmd=(mpv --no-video --really-quiet --force-window=no --volume="$volume_value" "$track")
      ;;
    ffplay)
      cmd=(ffplay -nodisp -hide_banner -loglevel warning -autoexit -volume "$volume_value" "$track")
      ;;
    cvlc)
      cmd=(cvlc --intf dummy --no-video --play-and-exit --volume "$(( volume_value * 256 / 100 ))" "$track")
      ;;
    play)
      cmd=(play -q "$track")
      ;;
  esac
}

send_signal_to_current() {
  local signal="$1"
  if [[ -s "$pid_file" ]]; then
    local pid
    pid=$(<"$pid_file")
    if [[ "$pid" =~ ^[0-9]+$ ]]; then
      kill "-$signal" "$pid" >/dev/null 2>&1 || kill "-$signal" "-$pid" >/dev/null 2>&1 || true
    fi
  fi
}

handle_control() {
  local command="${1,,}"
  case "$command" in
    play|resume)
      echo playing >"$state_file"
      send_signal_to_current CONT
      ;;
    pause)
      echo paused >"$state_file"
      send_signal_to_current STOP
      ;;
    toggle)
      if [[ -f "$state_file" && "$(<"$state_file")" == "paused" ]]; then
        echo playing >"$state_file"
        send_signal_to_current CONT
      else
        echo paused >"$state_file"
        send_signal_to_current STOP
      fi
      ;;
    next)
      echo next >"$command_file"
      send_signal_to_current TERM
      ;;
    previous|prev)
      echo previous >"$command_file"
      send_signal_to_current TERM
      ;;
    stop)
      echo stop >"$command_file"
      send_signal_to_current TERM
      ;;
    status)
      ;;
    *) echo "music-player: unknown control command: $command" >&2 ;;
  esac
}

control_loop() {
  while true; do
    if IFS= read -r command <"$control_fifo"; then
      handle_control "$command"
    fi
  done
}

control_main() {
  local state_dir
  state_dir=$(expand_path "${1:-}")
  local command="${2:-status}"
  if [[ -z "$state_dir" ]]; then usage; exit 2; fi
  mkdir -p "$state_dir"
  local fifo="$state_dir/control.fifo"
  if [[ "$command" == "status" ]]; then
    if [[ -f "$state_dir/status.txt" ]]; then cat "$state_dir/status.txt"; else echo "state=unknown"; fi
    return 0
  fi
  if [[ ! -p "$fifo" ]]; then
    echo "music-player: control fifo not found: $fifo" >&2
    exit 75
  fi
  printf '%s\n' "$command" >"$fifo"
  echo "music-player: command=$command sent state_dir=$state_dir"
}

play_main() {
  local source_arg="${1:-}"
  local loop_arg="${2:-true}"
  local volume_arg="${3:-70}"
  local player_arg="${4:-auto}"
  local event_delivery_arg="${6:-log}"
  state_dir=$(expand_path "${5:-${TMPDIR:-/tmp}/pi-auto-tools-music-player-$$}")
  if [[ -z "$source_arg" || "$source_arg" == "-h" || "$source_arg" == "--help" ]]; then usage; exit 2; fi
  mkdir -p "$state_dir"
  control_fifo="$state_dir/control.fifo"
  command_file="$state_dir/command.txt"
  state_file="$state_dir/player-state.txt"
  status_file="$state_dir/status.txt"
  status_json_file="$state_dir/player.json"
  event_file="$state_dir/outbox.jsonl"
  pid_file="$state_dir/current.pid"
  rm -f "$control_fifo" "$command_file" "$pid_file"
  mkfifo "$control_fifo"
  loop=$(parse_bool "$loop_arg")
  volume=$(normalize_volume "$volume_arg")
  player=$(select_player "$player_arg")
  event_delivery=$(normalize_delivery "$event_delivery_arg")
  load_playlist "$source_arg"
  echo playing >"$state_file"
  child_pid=""
  control_pid=""
  cleanup() {
    echo stopped >"$state_file" || true
    if [[ -n "$child_pid" ]]; then kill -TERM "$child_pid" >/dev/null 2>&1 || true; fi
    if [[ -n "$control_pid" ]]; then kill -TERM "$control_pid" >/dev/null 2>&1 || true; fi
    rm -f "$pid_file" "$control_fifo"
  }
  trap cleanup TERM INT HUP EXIT
  control_loop &
  control_pid="$!"
  local index=0
  local count=${#tracks[@]}
  echo "music-player: player=$player loop=$loop volume=$volume tracks=$count state_dir=$state_dir" >&2
  while true; do
    local track="${tracks[$index]}"
    player_command "$player" "$volume" "$track"
    echo playing >"$state_file"
    write_status playing "$index" "$count" "$track" "$player" ""
    "${cmd[@]}" &
    child_pid="$!"
    echo "$child_pid" >"$pid_file"
    write_status playing "$index" "$count" "$track" "$player" "$child_pid"
    emit_track_event "$index" "$count" "$track" "$player"
    wait "$child_pid" || true
    rm -f "$pid_file"
    child_pid=""
    local command=""
    if [[ -s "$command_file" ]]; then
      command=$(<"$command_file")
      : >"$command_file"
    fi
    case "$command" in
      stop)
        write_status stopped "$index" "$count" "$track" "$player" ""
        return 0
        ;;
      previous|prev)
        index=$(( (index - 1 + count) % count ))
        ;;
      next)
        index=$(( (index + 1) % count ))
        ;;
      *)
        if (( index + 1 >= count )); then
          if [[ "$loop" == true ]]; then index=0; else break; fi
        else
          index=$(( index + 1 ))
        fi
        ;;
    esac
  done
  write_status stopped "$index" "$count" "" "$player" ""
}

direct_control_main() {
  local command="$1"
  shift
  case "$command" in
    resume) command="play" ;;
  esac
  control_main "${1:-}" "$command"
}

mode="${1:-}"
case "$mode" in
  play) shift; play_main "$@" ;;
  control) shift; control_main "$@" ;;
  pause|resume|toggle|next|previous|prev|stop|status) shift; direct_control_main "$mode" "$@" ;;
  -h|--help|help|"") usage; [[ -n "$mode" ]] ;;
  *) play_main "$@" ;;
esac
