import * as clack from '@clack/prompts';
import { InterruptedError } from '../errors/index.js';
import type { Prompter } from '../ports/index.js';

function unwrap<T>(value: T): Exclude<T, symbol> {
  if (typeof value === 'symbol') throw new InterruptedError('Cancelled. Nothing was written.');
  return value as Exclude<T, symbol>;
}

/** Interactive prompts for a real terminal. Cancelling (Ctrl-C or Esc) raises InterruptedError. */
export function createClackPrompter(): Prompter {
  return {
    async text(message, options = {}) {
      if (options.secret === true) return unwrap(await clack.password({ message }));
      return unwrap(
        await clack.text({
          message,
          ...(options.default === undefined ? {} : { defaultValue: options.default, placeholder: options.default }),
        }),
      );
    },
    async confirm(message, options = {}) {
      return unwrap(await clack.confirm({ message, initialValue: options.default ?? false }));
    },
    async select<T extends string>(message: string, choices: readonly T[], options: { default?: T } = {}): Promise<T> {
      const picked = unwrap(
        await clack.select<string>({
          message,
          options: choices.map((value) => ({ value: value as string, label: value as string })),
          ...(options.default === undefined ? {} : { initialValue: options.default as string }),
        }),
      );
      return picked as T;
    },
    warn(message) {
      clack.log.warn(message);
    },
  };
}
