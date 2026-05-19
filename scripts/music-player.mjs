#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import {
  accessSync,
  closeSync,
  constants,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
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

const AUDIO_EXTENSIONS = new Set([".mp3", ".ogg", ".wav", ".flac", ".m4a"]);
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
  music-player.mjs play <source-file-dir-url-playlist-or-list> [loop=true] [volume=70] [player=auto] [state-dir] [event-delivery=log]
  music-player.mjs <pause|resume|toggle|next|previous|stop|status> <state-dir>
  music-player.mjs control <state-dir> <play|pause|toggle|next|previous|stop|status>

Runs a small foreground music player so pi-auto-tools can own it as an async run.
Actor message bodies are adapted to newline-delimited commands at <state-dir>/control.fifo.
Prefer message to=run:<run> type=player.<command> body=<command>, or use direct control commands below.
Supported players: auto, mpv, ffplay, cvlc, play.
`);
}

function fail(message, code = 1) {
  console.error(`music-player: ${message}`);
  process.exit(code);
}

function ensureUnixFifoSupport() {
  if (process.platform === "win32") {
    fail(
      "Unix FIFO controls are not available on native Windows; use WSL/Linux/macOS or a recipe-specific Windows transport.",
      70,
    );
  }
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

function isFifo(path) {
  try {
    const mode = statSync(path).mode & constants.S_IFMT;
    return mode === constants.S_IFIFO;
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

function normalizeDelivery(value) {
  const normalized = String(value).toLowerCase();
  if (["log", "notify", "followup"].includes(normalized)) return normalized;
  fail(`invalid event delivery: ${value}`, 2);
}

function selectPlayer(requested) {
  let selected = requested;
  if (selected === "auto") {
    selected = ["mpv", "ffplay", "cvlc", "play"].find(have) || selected;
  }
  if (!["mpv", "ffplay", "cvlc", "play"].includes(selected)) {
    fail(`unsupported player: ${requested}`, 2);
  }
  if (!have(selected)) fail(`player not found: ${selected}`, 127);
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
  if (tracks.length === 0) fail(`source has no playable tracks: ${sourceArg}`, 66);
  return tracks;
}

function playerCommand(player, volume, track) {
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

function emitTrackEvent(ctx, index, count, track, player) {
  const title = track.split(/[\\/]/).filter(Boolean).pop() || track;
  writeText(
    ctx.eventFile,
    `${JSON.stringify({
      body: { count, index, player, track },
      data: { count, index, player, track },
      delivery: ctx.eventDelivery,
      event: "player.track",
      from: `run:${basename(ctx.stateDir)}`,
      level: "info",
      summary: `Now playing: ${title}`,
      to: "coordinator",
      ts: new Date().toISOString(),
      type: "player.track",
    })}\n`,
    "a",
  );
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
  try {
    process.kill(pid, signal);
    return;
  } catch {
    // Fall through to process-group fallback.
  }
  try {
    process.kill(-pid, signal);
  } catch {
    // Best effort control signal.
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
      sendSignalToCurrent(ctx, "SIGCONT");
      break;
    case "pause":
      setState(ctx, "paused");
      sendSignalToCurrent(ctx, "SIGSTOP");
      break;
    case "toggle": {
      const current = readText(ctx.stateFile).trim();
      if (current === "paused") {
        setState(ctx, "playing");
        sendSignalToCurrent(ctx, "SIGCONT");
      } else {
        setState(ctx, "paused");
        sendSignalToCurrent(ctx, "SIGSTOP");
      }
      break;
    }
    case "next":
      writeText(ctx.commandFile, "next");
      sendSignalToCurrent(ctx, "SIGTERM");
      break;
    case "previous":
    case "prev":
      writeText(ctx.commandFile, "previous");
      sendSignalToCurrent(ctx, "SIGTERM");
      break;
    case "stop":
      writeText(ctx.commandFile, "stop");
      sendSignalToCurrent(ctx, "SIGTERM");
      break;
    case "status":
      break;
  }
}

function makeFifo(path) {
  rmSync(path, { force: true });
  const result = spawnSync("mkfifo", [path], { encoding: "utf8" });
  if (result.status !== 0) {
    const error =
      result.stderr.trim() || result.error?.message || "mkfifo failed";
    fail(error, result.status || 1);
  }
}

function startControlLoop(ctx) {
  makeFifo(ctx.controlFifo);
  const fd = openSync(ctx.controlFifo, constants.O_RDWR | constants.O_NONBLOCK);
  let carry = "";
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    try {
      closeSync(fd);
    } catch {}
  };
  const promise = (async () => {
    const buffer = Buffer.alloc(4096);
    while (!ctx.stopping) {
      try {
        const bytes = readSync(fd, buffer, 0, buffer.length, null);
        if (bytes > 0) {
          carry += buffer.subarray(0, bytes).toString("utf8");
          const lines = carry.split("\n");
          carry = lines.pop() || "";
          for (const line of lines) handleControl(ctx, line);
        } else {
          await sleep(50);
        }
      } catch (error) {
        if (ctx.stopping || closed) break;
        if (["EAGAIN", "EWOULDBLOCK"].includes(error.code)) {
          await sleep(50);
          continue;
        }
        console.error(`music-player: control loop error: ${error.message}`);
        await sleep(250);
      }
    }
  })();
  return { close, promise };
}

function playOne(ctx, player, volume, track, index, count) {
  return new Promise((resolveDone) => {
    const [command, args] = playerCommand(player, volume, track);
    writeStatus(ctx, "playing", index, count, track, player, "");
    const child = spawn(command, args, {
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
  ensureUnixFifoSupport();
  const [
    sourceArg,
    loopArg = "true",
    volumeArg = "70",
    playerArg = "auto",
    rawStateDir,
    eventDeliveryArg = "log",
  ] = args;
  if (!sourceArg || sourceArg === "-h" || sourceArg === "--help") {
    usage();
    process.exit(2);
  }
  const stateDir = expandPath(
    rawStateDir ||
      join(
        process.env.TMPDIR || "/tmp",
        `pi-auto-tools-music-player-${process.pid}`,
      ),
  );
  mkdirSync(stateDir, { recursive: true });
  const ctx = {
    commandFile: join(stateDir, "command.txt"),
    controlFifo: join(stateDir, "control.fifo"),
    current: undefined,
    eventDelivery: normalizeDelivery(eventDeliveryArg),
    eventFile: join(stateDir, "outbox.jsonl"),
    pidFile: join(stateDir, "current.pid"),
    stateDir,
    stateFile: join(stateDir, "player-state.txt"),
    statusFile: join(stateDir, "status.txt"),
    statusJsonFile: join(stateDir, "player.json"),
    stopping: false,
  };
  rmSync(ctx.controlFifo, { force: true });
  rmSync(ctx.commandFile, { force: true });
  rmSync(ctx.pidFile, { force: true });
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
    rmSync(ctx.controlFifo, { force: true });
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
  ensureUnixFifoSupport();
  const fifo = join(stateDir, "control.fifo");
  if (!isFifo(fifo)) fail(`control fifo not found: ${fifo}`, 75);
  let fd;
  try {
    fd = openSync(fifo, constants.O_WRONLY | constants.O_NONBLOCK);
    writeSync(fd, command.endsWith("\n") ? command : `${command}\n`);
  } catch (error) {
    fail(`control fifo is not ready: ${fifo}: ${error.message}`, 75);
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
  console.log(`music-player: command=${command} sent state_dir=${stateDir}`);
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
