#!/usr/bin/env node
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

try {
  process.exitCode = await run(process.argv.slice(2), {
    env: process.env,
    cwd: process.cwd(),
    out: (line) => process.stdout.write(line + '\n'),
    err: (line) => process.stderr.write(line + '\n'),
    signal: controller.signal,
    stdin: readStdin,
  });
} catch (error) {
  process.stderr.write(`tunnel crashed: ${(error as Error).stack ?? error}\n`);
  process.exitCode = 1;
}
