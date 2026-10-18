/**
 * `value` without its trailing slashes.
 *
 * A loop rather than `replace(/\/+$/, "")`: that pattern backtracks on a long
 * run of slashes followed by anything else, which a code scanner rightly
 * flags, and a loop costs one pass whatever the input.
 */
export function withoutTrailingSlashes(value: string): string {
  let end = value.length;

  while (end > 0 && value[end - 1] === "/") {
    end -= 1;
  }

  return value.slice(0, end);
}
