/** An error whose message is written for the person (or agent) running the CLI. */
export class TunnelError extends Error {
  constructor(
    message: string,
    readonly exitCode = 1,
  ) {
    super(message);
  }
}

/** The command was called wrong. Exit code 2, like most CLIs. */
export class UsageError extends TunnelError {
  constructor(message: string) {
    super(message, 2);
  }
}
