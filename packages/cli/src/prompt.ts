// Questions only a human at the keyboard can answer. A keystore password is read from the
// controlling terminal and nowhere else — no environment variable, no file, no piped stdin —
// because an AI agent with shell access can run `ch` too, and has no terminal to type into.
import { spawnSync } from "node:child_process";
import { closeSync, openSync, readSync, writeSync } from "node:fs";
import { isatty } from "node:tty";

export class NoTerminalError extends Error {
  constructor() {
    super("signing needs a human at a terminal: the keystore password is typed at a prompt, never read from an environment variable, a file or piped input — run this command yourself in an interactive terminal");
    this.name = "NoTerminalError";
  }
}

export class PromptAbortedError extends Error {
  constructor() {
    super("cancelled at the prompt — nothing was signed");
    this.name = "PromptAbortedError";
  }
}

export interface Prompter {
  /** A line typed without echo (passwords, private keys). */
  secret(question: string): Promise<string>;
  /** Yes/no; anything but y or yes is no. */
  confirm(question: string): Promise<boolean>;
  /** Text shown on the terminal, not on stdout (summaries before a signature). */
  say(text: string): void;
}

/** The real terminal: /dev/tty, opened per question, or NoTerminalError when there is none
 *  (a pipe, a CI job, an agent's shell, Windows). `ttyPath` exists so a test can point the gate
 *  at something that is not a terminal without ever touching the real one. */
export function terminalPrompter(ttyPath = "/dev/tty"): Prompter {
  const open = (): number => {
    if (process.platform === "win32") throw new NoTerminalError();
    let fd: number;
    try {
      fd = openSync(ttyPath, "r+");
    } catch {
      throw new NoTerminalError();
    }
    if (!isatty(fd)) {
      closeSync(fd);
      throw new NoTerminalError();
    }
    return fd;
  };
  const readLine = (fd: number): string => {
    const buf = Buffer.alloc(1024);
    let line = "";
    for (;;) {
      const n = readSync(fd, buf, 0, buf.length, null);
      if (n <= 0) break;
      line += buf.toString("utf8", 0, n);
      buf.fill(0);
      if (line.includes("\n")) break;
    }
    return line.replace(/\r?\n[\s\S]*$/, "");
  };
  const stty = (fd: number, arg: string): void => {
    spawnSync("stty", [arg], { stdio: [fd, "ignore", "ignore"] });
  };
  return {
    async secret(question) {
      const fd = open();
      // Ctrl-C while echo is off would leave the user's terminal blind; restore it first.
      const restore = (): void => {
        stty(fd, "echo");
        writeSync(fd, "\n");
        process.exit(130);
      };
      process.once("SIGINT", restore);
      try {
        writeSync(fd, question);
        stty(fd, "-echo");
        const line = readLine(fd);
        return line;
      } finally {
        stty(fd, "echo");
        writeSync(fd, "\n");
        process.removeListener("SIGINT", restore);
        closeSync(fd);
      }
    },
    async confirm(question) {
      const fd = open();
      try {
        writeSync(fd, `${question} [y/N] `);
        return /^(y|yes)$/i.test(readLine(fd).trim());
      } finally {
        closeSync(fd);
      }
    },
    say(text) {
      const fd = open();
      try {
        writeSync(fd, text.endsWith("\n") ? text : `${text}\n`);
      } finally {
        closeSync(fd);
      }
    },
  };
}
