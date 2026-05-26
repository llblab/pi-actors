#!/usr/bin/env node

/**
 * Packaged local music-player actor helper.
 *
 * This script backs the standard music-player recipe. It scans local music
 * sources, builds playback queues, launches an available backend player, and
 * consumes run-mailbox control messages such as play, pause, next, previous,
 * stop, and status.
 *
 * Keep the helper focused on one maintained player actor implementation; recipe
 * metadata and invocation arguments choose source paths and backend behavior.
 */

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  accessSync,
  constants,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  watch,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import {
  basename,
  delimiter,
  dirname,
  extname,
  isAbsolute,
  join,
  resolve,
} from "node:path";

const AUDIO_EXTENSIONS = new Set([
  ".aac",
  ".aif",
  ".aiff",
  ".flac",
  ".m4a",
  ".mp3",
  ".ogg",
  ".wav",
]);
const PLAYLIST_EXTENSIONS = new Set([".m3u", ".m3u8", ".txt"]);
const CONTROL_COMMANDS = new Set([
  "play",
  "resume",
  "pause",
  "toggle",
  "next",
  "previous",
  "prev",
  "stop",
  "status",
]);

function usage() {
  console.error(`Usage:
  music-player.mjs play <source-file-dir-url-playlist-or-list> [loop=true] [volume=70] [player=auto] [state-dir]
  music-player.mjs <pause|resume|toggle|next|previous|stop|status> <state-dir>
  music-player.mjs control <state-dir> <play|pause|toggle|next|previous|stop|status>

Runs a small foreground music player so pi-actors can own it as an actor run.
Actor message bodies are adapted to queued mailbox commands in <state-dir>/inbox.jsonl.
Prefer message to=run:<run> type=player.<command> body=<command>, or use direct control commands below.
Supported players: auto, mpv, afplay, ffplay, cvlc, play, wmp.
`);
}

function fail(message, code = 1) {
  console.error(`music-player: ${message}`);
  process.exit(code);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function expandPath(value) {
  if (value === "~") return homedir();
  if (value.startsWith("~/")) return join(homedir(), value.slice(2));
  return value;
}

function isUrl(value) {
  return /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(value);
}

function exists(path) {
  try {
    return existsSync(path);
  } catch {
    return false;
  }
}

function isDirectory(path) {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function isFile(path) {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function have(command) {
  const paths = (process.env.PATH || "").split(delimiter).filter(Boolean);
  const extensions =
    process.platform === "win32"
      ? (process.env.PATHEXT || ".EXE;.CMD;.BAT;.COM").split(";")
      : [""];
  for (const dir of paths) {
    for (const extension of extensions) {
      const candidate = join(dir, `${command}${extension}`);
      try {
        accessSync(candidate, constants.X_OK);
        return true;
      } catch {
        // Keep searching PATH.
      }
    }
  }
  return false;
}

function parseBool(value) {
  switch (String(value).toLowerCase()) {
    case "1":
    case "true":
    case "yes":
    case "y":
    case "on":
      return true;
    case "0":
    case "false":
    case "no":
    case "n":
    case "off":
      return false;
    default:
      fail(`invalid loop value: ${value}`, 2);
  }
}

function normalizeVolume(value) {
  if (!/^\d+$/.test(String(value))) fail("volume must be an integer 0..100", 2);
  return Math.min(Number(value), 100);
}

function powershellCommand() {
  return have("powershell") ? "powershell.exe" : undefined;
}

function windowsMediaPlayerExecutable() {
  if (process.platform !== "win32") return undefined;
  const roots = [
    process.env.ProgramFiles,
    process.env["ProgramFiles(x86)"],
    process.env.SystemDrive
      ? join(process.env.SystemDrive, "Program Files")
      : undefined,
    process.env.SystemDrive
      ? join(process.env.SystemDrive, "Program Files (x86)")
      : undefined,
  ];
  for (const root of roots.filter(Boolean)) {
    const candidate = join(root, "Windows Media Player", "wmplayer.exe");
    if (exists(candidate)) return candidate;
  }
  return undefined;
}

function havePlayer(player) {
  if (player === "wmp") {
    return (
      process.platform === "win32" &&
      Boolean(powershellCommand()) &&
      Boolean(windowsMediaPlayerExecutable())
    );
  }
  return have(player);
}

function selectPlayer(requested) {
  let selected = requested;
  if (selected === "auto") {
    let candidates;
    if (process.platform === "win32") {
      candidates = ["wmp", "mpv", "ffplay", "cvlc"];
    } else if (process.platform === "darwin") {
      candidates = ["mpv", "afplay", "ffplay", "cvlc", "play"];
    } else {
      candidates = ["mpv", "ffplay", "cvlc", "play"];
    }
    selected = candidates.find(havePlayer) || selected;
  }
  if (!["mpv", "afplay", "ffplay", "cvlc", "play", "wmp"].includes(selected)) {
    fail(`unsupported player: ${requested}`, 2);
  }
  if (selected === "wmp" && !havePlayer(selected)) {
    fail(
      "player not found: wmp requires native Windows, powershell.exe, and wmplayer.exe under Program Files/Windows Media Player",
      127,
    );
  }
  if (!havePlayer(selected)) fail(`player not found: ${selected}`, 127);
  return selected;
}

function addTrack(tracks, item) {
  const track = expandPath(item.trim());
  if (!track) return;
  if (isUrl(track) || exists(track)) {
    tracks.push(track);
    return;
  }
  console.error(`music-player: source entry not found: ${track}`);
}

function collectAudioFiles(dir, result = []) {
  const entries = readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      collectAudioFiles(path, result);
      continue;
    }
    if (
      entry.isFile() &&
      AUDIO_EXTENSIONS.has(extname(entry.name).toLowerCase())
    ) {
      result.push(path);
    }
  }
  return result;
}

function loadPlaylist(source) {
  const sourceArg = expandPath(source);
  const tracks = [];
  if (sourceArg.includes("|")) {
    for (const item of sourceArg.split("|")) addTrack(tracks, item);
  } else if (isUrl(sourceArg)) {
    tracks.push(sourceArg);
  } else if (isDirectory(sourceArg)) {
    tracks.push(
      ...collectAudioFiles(sourceArg).sort((a, b) => a.localeCompare(b)),
    );
  } else if (
    isFile(sourceArg) &&
    PLAYLIST_EXTENSIONS.has(extname(sourceArg).toLowerCase())
  ) {
    const baseDir = dirname(resolve(sourceArg));
    const lines = readFileSync(sourceArg, "utf8").split("\n");
    for (const rawLine of lines) {
      const line = rawLine.replace(/\r$/, "").trim();
      if (!line || line.startsWith("#")) continue;
      if (isUrl(line) || isAbsolute(line) || line.startsWith("~"))
        addTrack(tracks, line);
      else addTrack(tracks, join(baseDir, line));
    }
  } else if (exists(sourceArg)) {
    tracks.push(sourceArg);
  } else {
    fail(`source not found: ${sourceArg}`, 66);
  }
  if (tracks.length === 0)
    fail(`source has no playable tracks: ${sourceArg}`, 66);
  return tracks;
}

function windowsMediaPlayerCommand(ctx, volume, track) {
  const command = powershellCommand();
  const wmplayer = windowsMediaPlayerExecutable();
  if (!command || !wmplayer) {
    fail(
      "Windows Media Player backend requires powershell.exe and wmplayer.exe",
      127,
    );
  }
  const script = String.raw`
$ErrorActionPreference = 'Stop'
$track = $args[0]
$volume = [int]$args[1]
$controlFile = $args[2]
$wmplayerExe = $args[3]
if (-not (Test-Path -LiteralPath $wmplayerExe)) { throw "wmplayer.exe not found: $wmplayerExe" }
$player = New-Object -ComObject WMPlayer.OCX
$player.settings.volume = [Math]::Min([Math]::Max($volume, 0), 100)
$player.URL = $track
$player.controls.play()
try {
  while ($true) {
    Start-Sleep -Milliseconds 100
    if (Test-Path -LiteralPath $controlFile) {
      $control = (Get-Content -LiteralPath $controlFile -Raw -ErrorAction SilentlyContinue).Trim().ToLowerInvariant()
      Clear-Content -LiteralPath $controlFile -ErrorAction SilentlyContinue
      switch ($control) {
        'play' { $player.controls.play() }
        'pause' { $player.controls.pause() }
        'stop' { $player.controls.stop(); break }
      }
    }
    if ($player.playState -eq 1 -or $player.playState -eq 8) { break }
  }
} finally {
  $player.close()
}
`;
  return [
    command,
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      script,
      track,
      String(volume),
      ctx.playerControlFile,
      wmplayer,
    ],
  ];
}

function playerCommand(ctx, player, volume, track) {
  switch (player) {
    case "mpv":
      return [
        "mpv",
        [
          "--no-video",
          "--really-quiet",
          "--force-window=no",
          `--volume=${volume}`,
          track,
        ],
      ];
    case "afplay":
      return [
        "afplay",
        ["-v", String(Math.min(Math.max(volume / 100, 0), 1)), track],
      ];
    case "ffplay":
      return [
        "ffplay",
        [
          "-nodisp",
          "-hide_banner",
          "-loglevel",
          "warning",
          "-autoexit",
          "-volume",
          String(volume),
          track,
        ],
      ];
    case "cvlc":
      return [
        "cvlc",
        [
          "--intf",
          "dummy",
          "--no-video",
          "--play-and-exit",
          "--volume",
          String(Math.floor((volume * 256) / 100)),
          track,
        ],
      ];
    case "play":
      return ["play", ["-q", track]];
    case "wmp":
      return windowsMediaPlayerCommand(ctx, volume, track);
    default:
      fail(`unsupported player: ${player}`, 2);
  }
}

function writeText(path, value, flag = "w") {
  writeFileSync(path, value, { encoding: "utf8", flag });
}

function readText(path) {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

function emitPlayerEvent(ctx, type, summary, body = {}) {
  writeText(
    ctx.eventFile,
    `${JSON.stringify({
      body,
      data: body,
      delivery: "log",
      event: type,
      from: `run:${basename(ctx.stateDir)}`,
      level: "info",
      summary,
      to: "coordinator",
      ts: new Date().toISOString(),
      type,
    })}\n`,
    "a",
  );
}

function emitTrackEvent(ctx, index, count, track, player) {
  const title = track.split(/[\\/]/).filter(Boolean).pop() || track;
  emitPlayerEvent(ctx, "player.track", `Now playing: ${title}`, {
    count,
    index,
    player,
    track,
  });
}

function emitStoppedEvent(ctx, reason = "stop") {
  emitPlayerEvent(ctx, "player.stopped", "Music player stopped", { reason });
}

function writeStatus(ctx, state, index, count, track, player, pid = "") {
  const updatedAt = new Date().toISOString();
  writeText(
    ctx.statusFile,
    `state=${state}\nindex=${index}\ncount=${count}\ntrack=${track}\nplayer=${player}\npid=${pid}\nupdated_at=${updatedAt}\n`,
  );
  writeText(
    ctx.statusJsonFile,
    `${JSON.stringify({ state, index, count, track, player, pid: String(pid), updated_at: updatedAt })}\n`,
  );
  ctx.current = { count, index, pid: String(pid), player, state, track };
}

function setState(ctx, state) {
  writeText(ctx.stateFile, state);
  if (ctx.current) {
    writeStatus(
      ctx,
      state,
      ctx.current.index,
      ctx.current.count,
      ctx.current.track,
      ctx.current.player,
      ctx.current.pid,
    );
  }
}

function sendSignalToCurrent(ctx, signal) {
  const pid = Number(readText(ctx.pidFile).trim());
  if (!Number.isInteger(pid) || pid <= 0) return;
  if (process.platform !== "win32") {
    try {
      process.kill(-pid, signal);
      return;
    } catch {
      // Fall through to the direct child fallback.
    }
  }
  try {
    process.kill(pid, signal);
  } catch {
    // Best effort control signal.
  }
}

function controlCurrentPlayback(ctx, command) {
  if (ctx.current?.player === "wmp") {
    writeText(ctx.playerControlFile, command);
    return;
  }
  switch (command) {
    case "play":
      sendSignalToCurrent(ctx, "SIGCONT");
      break;
    case "pause":
      sendSignalToCurrent(ctx, "SIGSTOP");
      break;
    case "stop":
      sendSignalToCurrent(ctx, "SIGTERM");
      break;
  }
}

function handleControl(ctx, input) {
  const command = input.trim().toLowerCase();
  if (!command) return;
  if (!CONTROL_COMMANDS.has(command)) {
    console.error(`music-player: unknown control command: ${command}`);
    return;
  }
  switch (command) {
    case "play":
    case "resume":
      setState(ctx, "playing");
      controlCurrentPlayback(ctx, "play");
      break;
    case "pause":
      setState(ctx, "paused");
      controlCurrentPlayback(ctx, "pause");
      break;
    case "toggle": {
      const current = readText(ctx.stateFile).trim();
      if (current === "paused") {
        setState(ctx, "playing");
        controlCurrentPlayback(ctx, "play");
      } else {
        setState(ctx, "paused");
        controlCurrentPlayback(ctx, "pause");
      }
      break;
    }
    case "next":
      writeText(ctx.commandFile, "next");
      controlCurrentPlayback(ctx, "stop");
      break;
    case "previous":
    case "prev":
      writeText(ctx.commandFile, "previous");
      controlCurrentPlayback(ctx, "stop");
      break;
    case "stop":
      writeText(ctx.commandFile, "stop");
      controlCurrentPlayback(ctx, "stop");
      break;
    case "status":
      break;
  }
}

function runJsonFile(ctx) {
  return join(ctx.stateDir, "run.json");
}

function readJsonFile(path, fallback) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJsonFile(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function updateRunControlMetadata(ctx) {
  const path = runJsonFile(ctx);
  const run = readJsonFile(path, undefined);
  if (!run || typeof run !== "object") return;
  writeJsonFile(path, {
    ...run,
    control: { path: ctx.inboxFile, type: "mailbox" },
  });
}

function acquireInboxLock(ctx) {
  const lockDir = join(ctx.stateDir, ".inbox.lock");
  const started = Date.now();
  while (true) {
    try {
      mkdirSync(lockDir);
      writeJsonFile(join(lockDir, "owner.json"), {
        created_at: new Date().toISOString(),
        pid: process.pid,
      });
      return () => rmSync(lockDir, { recursive: true, force: true });
    } catch (error) {
      try {
        const stat = statSync(lockDir);
        if (Date.now() - stat.mtimeMs > 5 * 60 * 1000) {
          rmSync(lockDir, { recursive: true, force: true });
          continue;
        }
      } catch {
        continue;
      }
      if (Date.now() - started > 5000) throw error;
    }
  }
}

function readInboxMessages(ctx) {
  if (!exists(ctx.inboxFile)) return [];
  return readFileSync(ctx.inboxFile, "utf8")
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return undefined;
      }
    })
    .filter(Boolean);
}

function writeInboxMessages(ctx, messages) {
  writeFileSync(
    ctx.inboxFile,
    messages.length
      ? `${messages.map((message) => JSON.stringify(message)).join("\n")}\n`
      : "",
    "utf8",
  );
}

function commandFromControlToken(token) {
  if (CONTROL_COMMANDS.has(token)) return token;
  if (token === "control.stop" || token === "control.cancel") return "stop";
  const match = /^player\.(.+)$/.exec(token);
  if (match && CONTROL_COMMANDS.has(match[1])) return match[1];
  return undefined;
}

function commandFromInboxMessage(message) {
  if (typeof message.type === "string") {
    const command = commandFromControlToken(message.type.trim());
    if (command) return command;
  }
  if (typeof message.body === "string") {
    const command = message.body.trim();
    if (CONTROL_COMMANDS.has(command)) return command;
  }
  if (message.body && typeof message.body === "object") {
    const command = String(message.body.command ?? "").trim();
    if (CONTROL_COMMANDS.has(command)) return command;
  }
  return undefined;
}

function runtimeWakeFile(ctx) {
  return join(ctx.stateDir, "wake.jsonl");
}

function notifyMailboxWake(ctx, reason = "run.message") {
  try {
    writeText(
      runtimeWakeFile(ctx),
      `${JSON.stringify({
        actor: `run:${basename(ctx.stateDir)}`,
        id: randomUUID(),
        metadata: { command: "music-player" },
        reason,
        state_dir: ctx.stateDir,
        ts: new Date().toISOString(),
      })}\n`,
      "a",
    );
  } catch {
    // Wake records are advisory; the inbox remains the durable source of truth.
  }
}

function appendInboxCommand(ctx, command) {
  const release = acquireInboxLock(ctx);
  try {
    const ts = new Date().toISOString();
    const messages = readInboxMessages(ctx);
    messages.push({
      body: command,
      from: "coordinator",
      id: randomUUID(),
      queued_at: ts,
      received_at: ts,
      status: "queued",
      to: `run:${basename(ctx.stateDir)}`,
      type: `player.${command}`,
    });
    writeInboxMessages(ctx, messages);
  } finally {
    release();
  }
  notifyMailboxWake(ctx);
}

function claimInboxCommands(ctx) {
  const release = acquireInboxLock(ctx);
  try {
    const messages = readInboxMessages(ctx);
    const commands = [];
    let changed = false;
    const claimedAt = new Date().toISOString();
    for (const message of messages) {
      if (message.status !== "queued") continue;
      const command = commandFromInboxMessage(message);
      if (!command) {
        message.failed_at = claimedAt;
        message.status = "failed";
        message.error = "Unsupported music-player command";
        changed = true;
        continue;
      }
      message.claimed_at = claimedAt;
      message.claimed_by = `run:${basename(ctx.stateDir)}`;
      message.status = "claimed";
      commands.push({ command, id: message.id });
      changed = true;
    }
    if (changed) writeInboxMessages(ctx, messages);
    return commands;
  } finally {
    release();
  }
}

function finalizeInboxCommand(ctx, id, status, error) {
  if (!id) return;
  const release = acquireInboxLock(ctx);
  try {
    const messages = readInboxMessages(ctx);
    const timestamp = new Date().toISOString();
    let changed = false;
    for (const message of messages) {
      if (message.id !== id) continue;
      message.status = status;
      if (status === "handled") message.handled_at = timestamp;
      else message.failed_at = timestamp;
      if (error) message.error = error;
      changed = true;
    }
    if (changed) writeInboxMessages(ctx, messages);
  } finally {
    release();
  }
}

function inboxSignature(ctx) {
  try {
    const stat = statSync(ctx.inboxFile);
    return `${stat.size}:${stat.mtimeMs}`;
  } catch {
    return "missing";
  }
}

function startControlLoop(ctx) {
  let closed = false;
  let dirty = true;
  let watcher;
  try {
    watcher = watch(ctx.stateDir, { persistent: false }, (_eventType, file) => {
      const name = file ? String(file) : "";
      if (
        !name ||
        name === basename(ctx.inboxFile) ||
        name === basename(runtimeWakeFile(ctx))
      ) {
        dirty = true;
      }
    });
  } catch {
    // fs.watch is advisory; the signature poll below is the portable fallback.
  }
  const close = () => {
    closed = true;
    watcher?.close();
  };
  const promise = (async () => {
    let lastSignature = "";
    while (!ctx.stopping && !closed) {
      const signature = inboxSignature(ctx);
      if (dirty || signature !== lastSignature) {
        dirty = false;
        for (const { command, id } of claimInboxCommands(ctx)) {
          try {
            handleControl(ctx, command);
            finalizeInboxCommand(ctx, id, "handled");
          } catch (error) {
            finalizeInboxCommand(ctx, id, "failed", error.message);
          }
        }
        lastSignature = inboxSignature(ctx);
        continue;
      }
      await sleep(250);
    }
  })();
  return { close, promise };
}

function playOne(ctx, player, volume, track, index, count) {
  return new Promise((resolveDone) => {
    rmSync(ctx.playerControlFile, { force: true });
    const [command, args] = playerCommand(ctx, player, volume, track);
    writeStatus(ctx, "playing", index, count, track, player, "");
    const child = spawn(command, args, {
      detached: process.platform !== "win32",
      stdio: ["ignore", "inherit", "inherit"],
    });
    ctx.child = child;
    const pid = child.pid || "";
    if (pid) writeText(ctx.pidFile, String(pid));
    writeStatus(ctx, "playing", index, count, track, player, pid);
    emitTrackEvent(ctx, index, count, track, player);
    child.once("error", (error) => {
      console.error(
        `music-player: failed to start ${command}: ${error.message}`,
      );
      resolveDone();
    });
    child.once("exit", () => {
      rmSync(ctx.pidFile, { force: true });
      ctx.child = undefined;
      resolveDone();
    });
  });
}

function readAndClearCommand(ctx) {
  const command = readText(ctx.commandFile).trim();
  writeText(ctx.commandFile, "");
  return command;
}

async function playMain(args) {
  const [
    sourceArg,
    loopArg = "true",
    volumeArg = "70",
    playerArg = "auto",
    rawStateDir,
  ] = args;
  if (!sourceArg || sourceArg === "-h" || sourceArg === "--help") {
    usage();
    process.exit(2);
  }
  const stateDir = expandPath(
    rawStateDir ||
      join(
        process.env.TMPDIR || "/tmp",
        `pi-actors-music-player-${process.pid}`,
      ),
  );
  mkdirSync(stateDir, { recursive: true });
  const ctx = {
    commandFile: join(stateDir, "command.txt"),
    current: undefined,
    eventFile: join(stateDir, "outbox.jsonl"),
    inboxFile: join(stateDir, "inbox.jsonl"),
    pidFile: join(stateDir, "current.pid"),
    playerControlFile: join(stateDir, "player-control.txt"),
    stateDir,
    stateFile: join(stateDir, "player-state.txt"),
    statusFile: join(stateDir, "status.txt"),
    statusJsonFile: join(stateDir, "player.json"),
    stopping: false,
  };
  rmSync(ctx.commandFile, { force: true });
  rmSync(ctx.pidFile, { force: true });
  rmSync(ctx.playerControlFile, { force: true });
  const loop = parseBool(loopArg);
  const volume = normalizeVolume(volumeArg);
  const player = selectPlayer(playerArg);
  const tracks = loadPlaylist(sourceArg);
  let controlLoop;
  const cleanup = () => {
    ctx.stopping = true;
    writeText(ctx.stateFile, "stopped");
    if (ctx.child?.pid) {
      try {
        process.kill(ctx.child.pid, "SIGTERM");
      } catch {}
    }
    controlLoop?.close();
    rmSync(ctx.pidFile, { force: true });
    rmSync(ctx.playerControlFile, { force: true });
  };
  process.once("SIGTERM", () => {
    cleanup();
    process.exit(143);
  });
  process.once("SIGINT", () => {
    cleanup();
    process.exit(130);
  });
  process.once("SIGHUP", () => {
    cleanup();
    process.exit(129);
  });
  try {
    updateRunControlMetadata(ctx);
    controlLoop = startControlLoop(ctx);
    setState(ctx, "playing");
    console.error(
      `music-player: player=${player} loop=${loop} volume=${volume} tracks=${tracks.length} state_dir=${stateDir}`,
    );
    let index = 0;
    const count = tracks.length;
    while (!ctx.stopping) {
      const track = tracks[index];
      await playOne(ctx, player, volume, track, index, count);
      const command = readAndClearCommand(ctx);
      if (command === "stop") {
        writeStatus(ctx, "stopped", index, count, track, player, "");
        emitStoppedEvent(ctx, "message");
        return;
      }
      if (command === "previous" || command === "prev") {
        index = (index - 1 + count) % count;
        continue;
      }
      if (command === "next") {
        index = (index + 1) % count;
        continue;
      }
      if (index + 1 >= count) {
        if (loop) index = 0;
        else break;
      } else {
        index += 1;
      }
    }
    writeStatus(ctx, "stopped", index, tracks.length, "", player, "");
    emitStoppedEvent(ctx, "complete");
  } finally {
    cleanup();
    await Promise.race([controlLoop?.promise ?? Promise.resolve(), sleep(100)]);
  }
}

function controlMain(args) {
  const stateDir = expandPath(args[0] || "");
  const command = args[1] || "status";
  if (!stateDir) {
    usage();
    process.exit(2);
  }
  mkdirSync(stateDir, { recursive: true });
  if (command === "status") {
    const statusFile = join(stateDir, "status.txt");
    process.stdout.write(
      exists(statusFile) ? readText(statusFile) : "state=unknown\n",
    );
    return;
  }
  appendInboxCommand(
    { inboxFile: join(stateDir, "inbox.jsonl"), stateDir },
    command,
  );
  console.log(`music-player: command=${command} queued state_dir=${stateDir}`);
}

const [mode, ...rest] = process.argv.slice(2);
const directControlCommands = new Set([
  "pause",
  "resume",
  "toggle",
  "next",
  "previous",
  "prev",
  "stop",
  "status",
]);
if (mode === "play") await playMain(rest);
else if (mode === "control") controlMain(rest);
else if (directControlCommands.has(mode)) {
  controlMain([rest[0], mode === "resume" ? "play" : mode]);
} else if (!mode || mode === "-h" || mode === "--help" || mode === "help") {
  usage();
  process.exit(mode ? 0 : 2);
} else {
  await playMain([mode, ...rest]);
}
