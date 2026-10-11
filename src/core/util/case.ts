/** Split an identifier or phrase into lowercase words: "myApp_name" -> ["my", "app", "name"]. */
export function words(input: string): string[] {
  return input
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter((w) => w.length > 0)
    .map((w) => w.toLowerCase());
}

const capitalize = (w: string): string => w.charAt(0).toUpperCase() + w.slice(1);

export const kebabCase = (input: string): string => words(input).join('-');
export const snakeCase = (input: string): string => words(input).join('_');
export const pascalCase = (input: string): string => words(input).map(capitalize).join('');
export const camelCase = (input: string): string => {
  const [first = '', ...rest] = words(input);
  return first + rest.map(capitalize).join('');
};
