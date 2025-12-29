/**
 * lint-staged configuration
 *
 * Uses function syntax to properly escape file paths containing
 * special characters like parentheses and brackets (e.g., Next.js route groups).
 */

/**
 * Escape glob special characters for secretlint.
 * Secretlint uses micromatch which interprets [], () as glob patterns.
 *
 * This is necessary otherwise pre-commit hooks break any commits in
 * folders with parentheses, which is standard NextJS folder syntax.
 */
function escapeForSecretlint(filepath) {
  return filepath.replace(/([[\]()])/g, '\\$1');
}

module.exports = {
  '*': (filenames) => {
    // Escape glob special characters for secretlint
    const escaped = filenames
      .map((f) => `'${escapeForSecretlint(f)}'`)
      .join(' ');
    return `secretlint ${escaped}`;
  },
  '*.{js,jsx,ts,tsx}': (filenames) => {
    // Prettier handles quoted paths fine
    const escaped = filenames.map((f) => `"${f}"`).join(' ');
    return `prettier --write ${escaped}`;
  },
  '*.{json,md,yml,yaml}': (filenames) => {
    const escaped = filenames.map((f) => `"${f}"`).join(' ');
    return `prettier --write ${escaped}`;
  },
};
