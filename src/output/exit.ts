// Exit codes are part of the scripting contract. Tested in test/exit.test.ts.
export const EXIT_OK = 0;
export const EXIT_BAD_INPUT = 2;
export const EXIT_AUTH = 3;
export const EXIT_API = 4;
export const EXIT_TIMEOUT = 5;

export class CliError extends Error {
  readonly code: string;
  readonly exitCode: number;
  readonly hint?: string;

  constructor(code: string, message: string, exitCode: number, hint?: string) {
    super(message);
    this.code = code;
    this.exitCode = exitCode;
    this.hint = hint;
  }
}

export function badInput(message: string, hint?: string): CliError {
  return new CliError("bad_input", message, EXIT_BAD_INPUT, hint);
}
