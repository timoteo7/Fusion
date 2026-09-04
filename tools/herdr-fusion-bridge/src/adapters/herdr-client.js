// herdr-client.js — the HerdrClient interface and its real implementation.
//
// The interface reports pane listing, pane resolution for a task/executor,
// per-pane log replication and pane liveness. The CliHerdrClient shells out to
// the configured HBRIDGE_HERDR_BIN with subcommands and parses JSON. Any child
// process it spawns is bounded and killed on timeout; unit tests use fakes or a
// bounded fake command (never a real long-running command).

import { spawn } from 'node:child_process';

// The abstract contract. Concrete clients return plain data and throw (or
// resolve "absent/dead") on failure; they never busy-loop.
//
//   listPanes()            -> Promise<Array<{ paneId, alive?: boolean }>>
//   resolvePane(taskId, executorId) -> Promise<string | null>
//   logsForPane(paneId)    -> Promise<Array<string>>
//   isPaneAlive(paneId)    -> Promise<boolean>
export class AbstractHerdrClient {
  // eslint-disable-next-line no-unused-vars
  async listPanes() {
    throw new Error('HerdrClient.listPanes not implemented');
  }
  // eslint-disable-next-line no-unused-vars
  async resolvePane(taskId, executorId) {
    throw new Error('HerdrClient.resolvePane not implemented');
  }
  // eslint-disable-next-line no-unused-vars
  async logsForPane(paneId) {
    throw new Error('HerdrClient.logsForPane not implemented');
  }
  // eslint-disable-next-line no-unused-vars
  async isPaneAlive(paneId) {
    throw new Error('HerdrClient.isPaneAlive not implemented');
  }
}

// Expected JSON contract from the Herdr binary:
//
//   `herdr pane list`  -> { ok: true, panes: [{ paneId, alive }] }
//   `herdr pane resolve --task=<taskId>` -> { ok: true, paneId } (or { ok:false })
//   `herdr pane logs --pane=<paneId>` -> { ok: true, lines: ["...", ...] }
//   `herdr pane alive --pane=<paneId>` -> { ok: true, alive: true|false }
//
// Each subcommand is spawned with a bounded timeout and its stdout parsed as
// JSON. A non-zero exit, parse failure, or timeout yields the safe response
// (empty array / null / alive:false) rather than an exception that could spin.
export class CliHerdrClient {
  constructor({
    bin = 'herdr',
    spawnImpl = null,
    timeout = 2000,
    logger = null,
  } = {}) {
    this.bin = bin;
    this.timeout = timeout;
    this.logger = logger;
    this.spawnImpl = spawnImpl || ((cmd, args, opts) => spawn(cmd, args, opts));
  }

  // Run a subcommand and parse JSON from stdout. Resolves safely on failure.
  async run(cmdArgs) {
    const output = await runCaptured({
      spawnImpl: this.spawnImpl,
      cmd: this.bin,
      args: cmdArgs,
      timeout: this.timeout,
    });
    if (!output.ok) {
      return null;
    }
    try {
      return JSON.parse(output.stdout);
    } catch {
      return null;
    }
  }

  async listPanes() {
    const res = await this.run(['pane', 'list']);
    if (!res || !Array.isArray(res.panes)) {
      return [];
    }
    return res.panes.map((p) => ({ paneId: p.paneId, alive: p.alive !== false }));
  }

  async resolvePane(taskId, executorId) {
    const args = ['pane', 'resolve', `--task=${taskId}`];
    if (executorId) {
      args.push(`--executor=${executorId}`);
    }
    const res = await this.run(args);
    if (!res || !res.paneId) {
      return null;
    }
    return res.paneId;
  }

  async logsForPane(paneId) {
    const res = await this.run(['pane', 'logs', `--pane=${paneId}`]);
    if (!res || !Array.isArray(res.lines)) {
      return [];
    }
    return res.lines;
  }

  async isPaneAlive(paneId) {
    const res = await this.run(['pane', 'alive', `--pane=${paneId}`]);
    if (!res) {
      return false;
    }
    return res.alive === true;
  }
}

// Run a process capturing stdout, bounded by a timeout that kills the child.
// Never spins: on timeout/error/non-zero it resolves { ok:false }.
export function runCaptured({ cmd, args, timeout, spawnImpl }) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawnImpl(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      resolve({ ok: false, error: String(err && err.message ? err.message : err) });
      return;
    }
    let stdout = '';
    let stderr = '';
    let settled = false;
    const done = (payload) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve(payload);
      }
    };
    child.stdout.on('data', (d) => (stdout += d.toString()));
    child.stderr.on('data', (d) => (stderr += d.toString()));
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        // ignore
      }
      done({ ok: false, stdout, stderr, error: 'timeout' });
    }, timeout);
    child.on('error', (err) => done({ ok: false, stdout, stderr, error: String(err) }));
    child.on('close', (code) => {
      if (code === 0) {
        done({ ok: true, stdout, stderr });
      } else {
        done({ ok: false, stdout, stderr, exitCode: code });
      }
    });
  });
}