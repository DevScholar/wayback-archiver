/**
 * args.ts
 *
 * A small argv parser shared by the `merge` and `dedupe` commands, so both
 * accept the same spellings: `--flag=value` and `--flag value`, with a value
 * flag that may be repeated. Existing commands parse their own argv; this one
 * lives here so the two archive-rewriting commands do not drift apart.
 */

export interface ArgvResult {
  /** Every value written for a value flag, in order (`--title` seen twice keeps
   * both). Boolean flags record `"true"`. */
  values: Map<string, string[]>;
  /** Tokens that are not `--` flags. */
  positional: string[];
  /** Problems found while parsing: an unknown flag, a flag with no value, a
   * boolean flag given a value. */
  errors: string[];
}

export function parseArgv(
  argv: string[],
  valueFlags: readonly string[],
  booleanFlags: readonly string[] = [],
): ArgvResult {
  const values = new Map<string, string[]>();
  const positional: string[] = [];
  const errors: string[] = [];

  const add = (key: string, value: string): void => {
    const list = values.get(key);
    if (list) list.push(value);
    else values.set(key, [value]);
  };

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith("--")) {
      positional.push(token);
      continue;
    }

    const equals = token.indexOf("=");
    const key = equals >= 0 ? token.slice(0, equals) : token;
    const inline = equals >= 0 ? token.slice(equals + 1) : undefined;

    if (booleanFlags.includes(key)) {
      if (inline !== undefined) {
        errors.push(`option ${key} takes no value`);
        continue;
      }
      add(key, "true");
      continue;
    }
    if (!valueFlags.includes(key)) {
      errors.push(`unknown option ${key}`);
      continue;
    }
    if (inline !== undefined) {
      add(key, inline);
      continue;
    }
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) {
      errors.push(`option ${key} needs a value`);
      continue;
    }
    add(key, next);
    i++;
  }

  return { values, positional, errors };
}

/** Split a comma-separated flag value into its non-empty parts, trimmed. */
export function splitList(value: string): string[] {
  return value
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}
