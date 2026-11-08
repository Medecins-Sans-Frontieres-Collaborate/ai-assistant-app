/**
 * lint-staged configuration
 *
 * Uses function syntax so file paths containing shell or glob special
 * characters (Next.js dynamic segments `[id]`, route groups `(auth)`) are
 * passed through intact.
 */

/**
 * Quotes a path for lint-staged, which runs no shell: it splits the task
 * string with string-argv, which understands single or double quotes but
 * no escapes. So the path is wrapped in whichever quote it does not
 * contain.
 *
 * @throws When the path contains both quote characters (cannot be passed).
 */
function shellQuote(filepath) {
  if (!filepath.includes("'")) return `'${filepath}'`;
  if (!filepath.includes('"')) return `"${filepath}"`;
  throw new Error(
    `lint-staged: cannot pass a path containing both ' and ": ${filepath}`,
  );
}

module.exports = {
  '*': (filenames) =>
    // `--no-glob`: lint-staged hands over literal paths. secretlint 13's
    // walker treats every argument as a glob by default, so a path such as
    // app/api/file/[id]/route.ts matched nothing ("Not found target
    // files"), and the earlier backslash-escaping workaround stopped
    // matching too.
    `secretlint --no-glob ${filenames.map(shellQuote).join(' ')}`,
  '*.{js,jsx,ts,tsx}': (filenames) =>
    `prettier --write ${filenames.map(shellQuote).join(' ')}`,
  '*.{json,md,yml,yaml}': (filenames) =>
    `prettier --write ${filenames.map(shellQuote).join(' ')}`,
};
