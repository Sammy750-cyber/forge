import type Handlebars from 'handlebars';
import { shellQuote } from '../util/shell.js';
import { camelCase, kebabCase, pascalCase, snakeCase } from '../util/case.js';

type HandlebarsEnvironment = typeof Handlebars;

/** Drop the trailing Handlebars `options` argument that every helper receives. */
const positional = (args: readonly unknown[]): unknown[] => args.slice(0, -1);

/**
 * The complete, allow-listed set of template helpers. Templates cannot register their own,
 * so a template can never execute code of its own.
 */
export function registerHelpers(hb: HandlebarsEnvironment): void {
  hb.registerHelper('eq', (a: unknown, b: unknown) => a === b);
  hb.registerHelper('ne', (a: unknown, b: unknown) => a !== b);
  hb.registerHelper('not', (a: unknown) => !a);
  hb.registerHelper('and', (...args: unknown[]) => positional(args).every(Boolean));
  hb.registerHelper('or', (...args: unknown[]) => positional(args).some(Boolean));

  hb.registerHelper('kebabCase', (value: unknown) => kebabCase(String(value)));
  hb.registerHelper('snakeCase', (value: unknown) => snakeCase(String(value)));
  hb.registerHelper('camelCase', (value: unknown) => camelCase(String(value)));
  hb.registerHelper('pascalCase', (value: unknown) => pascalCase(String(value)));

  /** {{json value}} or {{json value 2}} for indented output. */
  hb.registerHelper('json', (value: unknown, spaces: unknown) =>
    JSON.stringify(value, null, typeof spaces === 'number' ? spaces : undefined),
  );
  /** {{indent 4 text}}: prefix every non-empty line with N spaces. */
  hb.registerHelper('indent', (count: unknown, text: unknown) => {
    const pad = ' '.repeat(typeof count === 'number' && count > 0 ? Math.min(count, 64) : 0);
    return String(text)
      .split('\n')
      .map((line) => (line.length > 0 ? pad + line : line))
      .join('\n');
  });
  /** A YAML double-quoted scalar. JSON string syntax is a subset of YAML's, so quoting is always valid. */
  hb.registerHelper('yamlString', (value: unknown) => JSON.stringify(String(value)));
  /** A POSIX shell single-quoted word. */
  hb.registerHelper('shellQuote', (value: unknown) => shellQuote(String(value)));
}
