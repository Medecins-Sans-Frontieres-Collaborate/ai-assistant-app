/**
 * Turn assistant markdown into something a text-to-speech voice can read.
 *
 * The TTS route already strips markdown chrome server-side
 * (`cleanMarkdown` in `lib/utils/app/clean.ts`), but it knows nothing about
 * math: it hands LaTeX straight to the synthesizer, which dutifully reads
 * "backslash frac open brace a close brace" out loud (issue #121). Worse, its
 * emphasis rule — `text.replace(/[*_]{1,3}(.*?)[*_]{1,3}/g, '$1')` — eats the
 * underscores in `x_1 \le y_2` and mangles the TeX before anyone can do
 * anything sensible with it.
 *
 * So this runs FIRST, on the client, before the request is sent: by the time
 * the server sees the text there is no LaTeX left for the emphasis rule to
 * shred. It deliberately does NOT duplicate `cleanMarkdown` — headings, bold,
 * links and code fences stay that function's job, so there is one place to
 * change them.
 */

/** Options for {@link toSpeakableText}. */
export interface SpeakableTextOptions {
  /**
   * Spoken stand-in for an expression too structured to say in a sentence
   * (a matrix, an `aligned` derivation, anything with commands we do not
   * verbalize). Pass a localized string from `messages/en.json` at the call
   * site; the default is English so the helper stays usable from non-React
   * code.
   */
  equationPlaceholder?: string;
}

const DEFAULT_PLACEHOLDER = 'equation';

/**
 * Regions to walk in one pass. Order matters: code fences and inline code come
 * first so a shell snippet containing `$$` is copied through untouched, and
 * `$$...$$` precedes `$...$` so the longer delimiter wins.
 *
 * The unterminated-fence arm (`(?:```|$)`) matters for the document editor,
 * which can hand us a half-written document.
 */
const SEGMENT_RE = new RegExp(
  [
    '```[\\s\\S]*?(?:```|$)', // fenced code
    '~~~[\\s\\S]*?(?:~~~|$)', // fenced code, tilde form
    '`[^`\\n]*`', // inline code span
    '\\$\\$[\\s\\S]*?\\$\\$', // $$ ... $$  (display and inline)
    '\\\\\\[[\\s\\S]*?\\\\\\]', // \[ ... \]
    '\\\\\\([\\s\\S]*?\\\\\\)', // \( ... \)
    '\\$[^$\\n]*\\$', // $ ... $  (guarded below — usually currency)
  ].join('|'),
  'g',
);

/**
 * A single `$` only opens math when the span between the dollars carries a TeX
 * signal. Without this guard "budget is $5,000 for supplies and $12,000 for
 * staff" — the single most common shape in MSF writing — is heard as "budget
 * is equation for staff". The on-screen renderer does not treat single
 * dollars as math either (Streamdown pins `singleDollarTextMath: false`), so
 * being conservative here also keeps speech aligned with the screen.
 */
const TEX_SIGNAL_RE = /\\[a-zA-Z]|[\^_]/;

/** Environments and constructs with layout we cannot say in a sentence. */
const UNSPEAKABLE_RE = /\\begin\{|\\end\{|\\\\|&/;

/** Longest expression we will try to read out symbol by symbol. */
const MAX_VERBALIZED_LENGTH = 120;

/**
 * TeX commands with a plain-English reading. Both the abbreviated and spelled
 * forms of the comparisons are listed because the tokenizer below captures the
 * whole command name, so `\le` and `\leq` arrive as different keys.
 */
const SPOKEN_COMMANDS: Record<string, string> = {
  // Greek — read as their names, which is how a person says them aloud.
  alpha: 'alpha',
  beta: 'beta',
  gamma: 'gamma',
  Gamma: 'capital gamma',
  delta: 'delta',
  Delta: 'delta',
  epsilon: 'epsilon',
  varepsilon: 'epsilon',
  zeta: 'zeta',
  eta: 'eta',
  theta: 'theta',
  Theta: 'capital theta',
  kappa: 'kappa',
  lambda: 'lambda',
  Lambda: 'capital lambda',
  mu: 'mu',
  nu: 'nu',
  xi: 'xi',
  pi: 'pi',
  Pi: 'capital pi',
  rho: 'rho',
  sigma: 'sigma',
  Sigma: 'capital sigma',
  tau: 'tau',
  phi: 'phi',
  varphi: 'phi',
  Phi: 'capital phi',
  chi: 'chi',
  psi: 'psi',
  Psi: 'capital psi',
  omega: 'omega',
  Omega: 'capital omega',

  // Operators and relations.
  times: 'times',
  cdot: 'times',
  div: 'divided by',
  pm: 'plus or minus',
  mp: 'minus or plus',
  le: 'less than or equal to',
  leq: 'less than or equal to',
  ge: 'greater than or equal to',
  geq: 'greater than or equal to',
  ne: 'not equal to',
  neq: 'not equal to',
  approx: 'approximately',
  equiv: 'is equivalent to',
  propto: 'is proportional to',
  sim: 'about',
  ll: 'much less than',
  gg: 'much greater than',
  to: 'goes to',
  rightarrow: 'goes to',
  Rightarrow: 'implies',
  leftarrow: 'comes from',
  in: 'in',
  notin: 'not in',
  subset: 'is a subset of',
  cup: 'union',
  cap: 'intersection',
  infty: 'infinity',
  percent: 'percent',
  degree: 'degrees',
  circ: 'degrees',

  // Big operators — "of" so "\sum x" reads "sum of x".
  sum: 'sum of',
  prod: 'product of',
  int: 'integral of',
  lim: 'limit of',
  partial: 'partial',
  nabla: 'gradient',

  // Ellipses.
  dots: 'and so on',
  ldots: 'and so on',
  cdots: 'and so on',

  // Functions that are already words.
  log: 'log',
  ln: 'natural log',
  exp: 'exponential of',
  sin: 'sine',
  cos: 'cosine',
  tan: 'tangent',
  min: 'minimum of',
  max: 'maximum of',
  bar: 'bar',
  hat: 'hat',
};

/** Commands that only affect layout, so they contribute no sound at all. */
const SILENT_COMMANDS_RE =
  /\\(?:left|right|bigg?l?r?|Bigg?l?r?|displaystyle|textstyle|scriptstyle|limits|nolimits|quad|qquad|space|hspace|vspace|mathstrut|phantom)\b/g;

/** Escape sequences for literal characters, plus the thin-space family. */
const ESCAPED_LITERALS: Record<string, string> = {
  '\\$': ' dollars ',
  '\\%': ' percent ',
  '\\&': ' and ',
  '\\#': ' number ',
  '\\_': ' ',
  '\\{': ' ',
  '\\}': ' ',
};

/** Bare symbols, applied after every command has been consumed. */
const SPOKEN_SYMBOLS: [RegExp, string][] = [
  [/≤/g, ' less than or equal to '],
  [/≥/g, ' greater than or equal to '],
  [/≠/g, ' not equal to '],
  [/=/g, ' equals '],
  [/\+/g, ' plus '],
  // A hyphen only reads as "minus" between two operands; `\w-\w` inside a word
  // that survived from \text{} must stay a hyphen.
  [/(?<=[\w)\]}\s])-(?=[\w([{\s])/g, ' minus '],
  [/</g, ' less than '],
  [/>/g, ' greater than '],
  [/\|/g, ' '],
  [/[{}]/g, ' '],
];

/**
 * Read one TeX expression aloud, or fall back to the placeholder.
 *
 * The rewrite order is not arbitrary: `\frac` and `\sqrt` have to consume
 * their brace groups BEFORE the generic `{}`-stripping runs, and the
 * superscript rules have to run before the command table, or `x^\pi` loses its
 * exponent structure. The final bail-out is the important part — anything
 * still carrying a backslash after every rule has run is a command we do not
 * know, and guessing at it produces worse audio than saying "equation".
 */
function verbalizeTex(rawTex: string, placeholder: string): string {
  const tex = rawTex.trim();
  if (!tex) return '';
  // Multi-line environments, alignment markers and explicit line breaks carry
  // two-dimensional layout that a linear voice cannot convey.
  if (UNSPEAKABLE_RE.test(tex) || tex.length > MAX_VERBALIZED_LENGTH) {
    return placeholder;
  }

  let out = tex;

  // Text runs inside math are already prose.
  out = out.replace(
    /\\(?:text|textrm|textbf|textit|mathrm|mathbf|mathit|mathcal|operatorname)\s*\{([^{}]*)\}/g,
    ' $1 ',
  );

  // Fractions, innermost first. Bounded loop rather than `while`: a runaway
  // rewrite on adversarial input is not worth the extra nesting depth.
  for (let depth = 0; depth < 4; depth += 1) {
    const next = out.replace(
      /\\[dt]?frac\s*\{([^{}]*)\}\s*\{([^{}]*)\}/g,
      ' $1 over $2 ',
    );
    if (next === out) break;
    out = next;
  }
  out = out.replace(/\\sqrt\s*\{([^{}]*)\}/g, ' square root of $1 ');

  // Powers. `^2` / `^3` get their idiomatic English names; everything else
  // falls back to the literal reading.
  out = out.replace(/\^\s*\{?\s*2\s*\}?/g, ' squared ');
  out = out.replace(/\^\s*\{?\s*3\s*\}?/g, ' cubed ');
  out = out.replace(/\^\s*\{([^{}]*)\}/g, ' to the power of $1 ');
  out = out.replace(/\^\s*(\\?[A-Za-z0-9]+)/g, ' to the power of $1 ');

  // Subscripts. "sub" is how the index is read in speech.
  out = out.replace(/_\s*\{([^{}]*)\}/g, ' sub $1 ');
  out = out.replace(/_\s*([A-Za-z0-9]+)/g, ' sub $1 ');

  out = out.replace(SILENT_COMMANDS_RE, ' ');
  // Explicit spacing macros: `\,` `\;` `\:` `\!` and friends.
  out = out.replace(/\\[,;:!>]/g, ' ');
  for (const [literal, spoken] of Object.entries(ESCAPED_LITERALS)) {
    out = out.split(literal).join(spoken);
  }

  out = out.replace(
    /\\([A-Za-z]+)/g,
    (match, name: string) => SPOKEN_COMMANDS[name] ?? match,
  );

  // Anything left with a backslash is a command we have no reading for, and a
  // half-verbalized formula is worse audio than an honest placeholder.
  if (/\\/.test(out)) return placeholder;

  for (const [pattern, spoken] of SPOKEN_SYMBOLS) {
    out = out.replace(pattern, spoken);
  }

  out = out.replace(/\s+/g, ' ').trim();
  return out || placeholder;
}

/**
 * Replace every LaTeX span in `markdown` with something speakable.
 *
 * Simple expressions are read out (`$$E = mc^2$$` → "E equals m c squared");
 * anything structural — a matrix, an `aligned` derivation, an unrecognised
 * command — collapses to `equationPlaceholder` rather than being spelled out
 * character by character. Code spans and fenced blocks are copied through
 * untouched, and a lone `$` is left alone unless the span between the dollars
 * carries a TeX signal, so currency figures survive intact.
 *
 * Everything outside math is returned unchanged: the server's `cleanMarkdown`
 * still strips the remaining markdown chrome, and keeping that in one place
 * beats having two half-strippers disagree.
 */
export function toSpeakableText(
  markdown: string,
  options: SpeakableTextOptions = {},
): string {
  const placeholder = options.equationPlaceholder ?? DEFAULT_PLACEHOLDER;

  // Nothing that could possibly be math: return the input untouched. Most
  // assistant messages take this path.
  if (
    !markdown.includes('$') &&
    !markdown.includes('\\[') &&
    !markdown.includes('\\(')
  ) {
    return markdown;
  }

  // SEGMENT_RE has no capturing groups, so the callback signature is the
  // three-argument form and `offset`/`whole` are the neighbour lookup used for
  // spacing below.
  const spoken = markdown.replace(
    SEGMENT_RE,
    (segment: string, offset: number, whole: string) => {
      if (segment.startsWith('`') || segment.startsWith('~')) return segment;

      let tex: string;
      if (segment.startsWith('$$')) {
        tex = segment.slice(2, -2);
      } else if (segment.startsWith('\\[') || segment.startsWith('\\(')) {
        tex = segment.slice(2, -2);
      } else {
        tex = segment.slice(1, -1);
        if (!TEX_SIGNAL_RE.test(tex)) return segment;
      }

      const verbalized = verbalizeTex(tex, placeholder);
      // Pad only where the neighbours need it, so a formula never fuses onto
      // the next word ("isequation") and an equation that ends a sentence is
      // not left with a space before its full stop.
      const before = whole[offset - 1];
      const after = whole[offset + segment.length];
      const padLeft = before !== undefined && !/\s/.test(before) ? ' ' : '';
      const padRight =
        after !== undefined && !/[\s.,;:!?)\]}]/.test(after) ? ' ' : '';
      if (!verbalized) return padLeft || padRight;
      return `${padLeft}${verbalized}${padRight}`;
    },
  );

  // Collapse only runs of spaces/tabs; paragraph breaks are prosody the
  // synthesizer uses for pauses, so newlines are left alone.
  return spoken.replace(/[ \t]{2,}/g, ' ').replace(/[ \t]+\n/g, '\n');
}
