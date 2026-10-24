/**
 * run-log.ts
 *
 * A command line run's console output, mirrored into a log file next to the
 * archive.
 *
 * A restore run takes a long time and reports what happened to every resource:
 * which capture was reused from the input, which one was fetched, which one was
 * shifted to another capture time, and which one failed. A terminal buffer is
 * gone once the window closes, so the same lines also go to a file that can be
 * read after the fact.
 *
 * The file is opened in append mode: a run resumes an existing output archive,
 * and every run adds its own block, so the log keeps the history of the
 * archive rather than only the newest attempt. A log that cannot be opened
 * never fails the run; it falls back to the console with a warning.
 */

import * as fs from "fs";

/** Describe an unknown thrown value in one line. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class RunLog {
  private descriptor: number | null = null;

  /** `filePath` is the log file to append to. */
  constructor(readonly filePath: string) {
    try {
      this.descriptor = fs.openSync(filePath, "a");
    } catch (error) {
      console.warn(
        `Could not open the log file ${filePath} (${messageOf(error)}); this run logs to the console only.`,
      );
    }
  }

  /** One line to the console and to the log file. */
  line(message = ""): void {
    console.log(message);
    this.write(message + "\n");
  }

  /** One line to the log file only, for detail that would flood the console
   * (a per-resource decision, the redirect chain of a fetch). */
  note(message: string): void {
    this.write(message + "\n");
  }

  /** An error line to the console's error stream and to the log file. */
  error(message: string): void {
    console.error(message);
    this.write(message + "\n");
  }

  /** Release the log file. Safe to call more than once. */
  close(): void {
    if (this.descriptor === null) return;
    try {
      fs.closeSync(this.descriptor);
    } catch {
      /* closing must never fail the run */
    }
    this.descriptor = null;
  }

  private write(text: string): void {
    if (this.descriptor === null) return;
    try {
      fs.writeSync(this.descriptor, text);
    } catch {
      /* a log write must never fail the run */
    }
  }
}
