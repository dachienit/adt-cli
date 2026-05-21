"use strict";

// Minimal ANSI-colored logger. No deps. Plays nicely when piped (auto-detects TTY).
// Verbosity levels:
//   0 = quiet  (errors only)
//   1 = normal (errors + warnings + step + final body)
//   2 = verbose ( + request method/url, status, headers summary)
//   3 = debug   ( + full request/response headers + small body previews)

const isTTY = !!(process.stderr && process.stderr.isTTY);
const useColor = isTTY && process.env.NO_COLOR == null;

const c = (code) => (s) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : String(s));
const colors = {
  dim: c("2"),
  bold: c("1"),
  red: c("31"),
  green: c("32"),
  yellow: c("33"),
  blue: c("34"),
  magenta: c("35"),
  cyan: c("36"),
  gray: c("90"),
};

let level = 1;

function setLevel(n) {
  level = Math.max(0, Math.min(3, n | 0));
}

function getLevel() {
  return level;
}

function fmt(prefix, color, parts) {
  const tag = color ? color(prefix) : prefix;
  return `${colors.gray(timestamp())} ${tag} ${parts.join(" ")}`;
}

function timestamp() {
  const d = new Date();
  return d.toTimeString().slice(0, 8);
}

function err(...parts) {
  // Always print errors.
  process.stderr.write(fmt("ERR ", colors.red, parts.map(toStr)) + "\n");
}

function warn(...parts) {
  if (level >= 1) process.stderr.write(fmt("WARN", colors.yellow, parts.map(toStr)) + "\n");
}

function info(...parts) {
  if (level >= 1) process.stderr.write(fmt("INFO", colors.cyan, parts.map(toStr)) + "\n");
}

function step(...parts) {
  if (level >= 1) process.stderr.write(fmt("STEP", colors.magenta, parts.map(toStr)) + "\n");
}

function ok(...parts) {
  if (level >= 1) process.stderr.write(fmt("OK  ", colors.green, parts.map(toStr)) + "\n");
}

function http(...parts) {
  if (level >= 2) process.stderr.write(fmt("HTTP", colors.blue, parts.map(toStr)) + "\n");
}

function debug(...parts) {
  if (level >= 3) process.stderr.write(fmt("DBG ", colors.gray, parts.map(toStr)) + "\n");
}

function toStr(v) {
  if (v == null) return String(v);
  if (typeof v === "string") return v;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

// stdout helpers - reserved strictly for command "result" output so that pipes work.
function out(s) {
  process.stdout.write(typeof s === "string" ? s : JSON.stringify(s, null, 2));
  if (!String(s).endsWith("\n")) process.stdout.write("\n");
}

function outRaw(s) {
  process.stdout.write(typeof s === "string" ? s : Buffer.isBuffer(s) ? s : JSON.stringify(s));
}

module.exports = {
  setLevel,
  getLevel,
  err,
  warn,
  info,
  step,
  ok,
  http,
  debug,
  out,
  outRaw,
  colors,
};
