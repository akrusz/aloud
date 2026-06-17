#!/usr/bin/env node
// Dev launcher: runs several long-lived processes as one.
//
// Replaces `(trap 'kill 0' SIGINT; a & b & wait)`, which needed multiple Ctrl-C
// to fully exit and left the server running when the Tauri window was closed.
//
// Properties:
//   - A single Ctrl-C tears the whole tree down.
//   - If any process exits on its own (e.g. you close the Tauri window), the
//     others are stopped too and the launcher exits.
//
// Each child runs in its own process group (detached) with /dev/null on stdin,
// so the terminal's Ctrl-C goes only to this launcher — which then signals each
// child's group exactly once. No double-delivery, no job-control surprises.
//
// Usage: node scripts/dev.mjs "label=shell command" "label=shell command" ...

import { spawn } from 'node:child_process';

const specs = process.argv.slice(2).map((arg) => {
  const eq = arg.indexOf('=');
  return eq === -1
    ? { label: arg, command: arg }
    : { label: arg.slice(0, eq), command: arg.slice(eq + 1) };
});

if (specs.length === 0) {
  console.error('dev: no commands given');
  process.exit(1);
}

const children = specs.map(({ label, command }) => {
  const child = spawn(command, {
    shell: true,
    stdio: ['ignore', 'inherit', 'inherit'],
    detached: true, // own process group, so we can signal the whole subtree at once
  });
  child.label = label;
  child.on('error', (err) => {
    console.error(`[dev] failed to start "${label}": ${err.message}`);
    shutdown(`"${label}" failed to start`, 1);
  });
  return child;
});

let shuttingDown = false;

function isAlive(child) {
  return child.exitCode === null && child.signalCode === null;
}

function killGroup(child, signal) {
  if (!isAlive(child)) return;
  try {
    process.kill(-child.pid, signal); // negative pid → the child's process group
  } catch {
    /* already gone */
  }
}

function shutdown(reason, code) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n[dev] ${reason}; stopping...`);

  for (const child of children) killGroup(child, 'SIGTERM');

  const force = setTimeout(() => {
    for (const child of children) killGroup(child, 'SIGKILL');
    process.exit(code);
  }, 4000);
  force.unref();

  let pending = children.filter(isAlive).length;
  if (pending === 0) process.exit(code);
  for (const child of children) {
    child.once('exit', () => {
      if (--pending === 0) process.exit(code);
    });
  }
}

for (const child of children) {
  child.on('exit', (code, signal) => {
    if (!shuttingDown) shutdown(`"${child.label}" exited (${signal ?? `code ${code}`})`, code ?? 0);
  });
}

for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, () => shutdown(`received ${sig}`, 0));
}
