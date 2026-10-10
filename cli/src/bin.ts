#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { run } from './cli.js';

const controller = new AbortController();
const stop = () => {
  if (controller.signal.aborted) process.exit(130);
  controller.abort();
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

/** Open a link in the browser when a person is at the terminal. Agents read the printed link instead. */
function openUrl(url: string) {
  if (!process.stdout.isTTY || !/^https?:\/\//.test(url)) return;
  const [command, args]: [string, string[]] =
    process.platform === 'win32'
      ? ['rundll32', ['url.dll,FileProtocolHandler', url]]
      : process.platform === 'darwin'
        ? ['open', [url]]
        : ['xdg-open', [url]];
  try {
    const child = spawn(command, args, { detached: true, stdio: 'ignore' });
    child.on('error', () => {}); // no browser here; the link is printed anyway
    child.unref();
  } catch {
    // same: the printed link is enough
  }
}

try {
  process.exitCode = await run(process.argv.slice(2), {
    env: process.env,
    cwd: process.cwd(),
    out: (line) => process.stdout.write(line + '\n'),
    err: (line) => process.stderr.write(line + '\n'),
    signal: controller.signal,
    stdin: readStdin,
    openUrl,
  });
} catch (error) {
  process.stderr.write(`tunnel crashed: ${(error as Error).stack ?? error}\n`);
  process.exitCode = 1;
}
