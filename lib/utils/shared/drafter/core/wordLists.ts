/**
 * Word lists for the deterministic evidence layer: the words that turn,
 * narrow, hedge or link a statement, the words that are only grammar, and
 * the verbs of saying. Pure data plus three functions; no imports.
 *
 * Every entry is lowercase with ASCII apostrophes (what
 * `normalizeForQuoteMatch` produces) and is looked up AFTER `foldKey`, so
 * each list also holds the accent-stripped twin of every entry: "jamás" and
 * "jamas" both hit. Languages: en, fr, es, de, pt, it, ar.
 *
 * Invariant (unit-tested): STOP_WORDS never holds a polarity, contrast,
 * causal or modal word, so "not", "only", "sin" or "mai" are never swallowed
 * as grammar.
 */

/**
 * The lookup form of a word: accents and Arabic vowel marks stripped, the
 * tatweel removed, hamza-carrying alifs, ta marbuta and alif maqsura
 * unified, then lowercase.
 */
export function foldKey(word: string): string {
  return word
    .normalize('NFD')
    .replace(/\p{Mn}/gu, '')
    .replace(/ـ/gu, '')
    .replace(/[أإآ]/gu, 'ا')
    .replace(/ة/gu, 'ه')
    .replace(/ى/gu, 'ي')
    .toLowerCase();
}

/** A set built from a space-separated list, with the folded twin of each entry. */
function words(list: string): ReadonlySet<string> {
  const set = new Set<string>();
  for (const word of list.split(/\s+/u)) {
    if (!word) continue;
    set.add(word);
    set.add(foldKey(word));
  }
  return set;
}

function union(...sets: ReadonlySet<string>[]): ReadonlySet<string> {
  const all = new Set<string>();
  for (const set of sets) for (const word of set) all.add(word);
  return all;
}

/**
 * Words that turn the meaning of what follows. A partial quotation that
 * starts right after one ("have enough water" out of "did not have enough
 * water") is verbatim and says the opposite.
 */
export const NEGATORS: ReadonlySet<string> = words(`
  not no never without nor cannot neither nobody nothing none nowhere
  ne pas jamais sans ni aucun aucune guère rien plus personne nul nulle
  point aucunement
  nunca sin jamás nadie nada ninguno ninguna ningún tampoco
  nicht kein keine keinen keinem keiner keines nie niemals ohne
  não sem nem ninguém nenhum nenhuma
  non mai senza né nessuno nessuna niente nulla
  لا لم لن ليس ليست ليسوا غير بدون دون ما
`);

/** Words that narrow a claim: "only", "almost", "except". */
export const SCOPE_CHANGERS: ReadonlySet<string> = words(`
  only just hardly barely rarely seldom few almost nearly merely scarcely
  except unless
  seulement uniquement presque peine quasiment sauf seul seule seuls seules
  solo sólo apenas casi salvo excepto únicamente
  nur fast kaum beinahe außer bloß
  só apenas quase exceto salvo somente
  solo soltanto appena quasi tranne eccetto
  فقط تقريبا تقريباً إلا عدا
`);

export const POLARITY_WORDS: ReadonlySet<string> = union(
  NEGATORS,
  SCOPE_CHANGERS,
);

/** Words that set what follows against what came before. */
export const CONTRAST_WORDS: ReadonlySet<string> = words(`
  but yet however although though whereas while except unless instead
  mais pourtant cependant toutefois néanmoins quoique sauf alors
  pero sino aunque salvo excepto mientras embargo
  aber sondern obwohl jedoch außer doch während
  mas porém embora contudo exceto todavia
  ma però sebbene tuttavia tranne mentre
  لكن ولكن إلا بينما رغم
`);

/**
 * Words that scale or name a number: put into a [bracketed insertion] they
 * change a figure the speaker gave ("1,200 [million]"), so an insertion may
 * never carry one.
 */
export const MAGNITUDE_WORDS: ReadonlySet<string> = words(`
  hundred hundreds thousand thousands million millions billion billions
  trillion dozen dozens percent half quarter double triple twice
  thrice
  cent cents mille milliers millier million millions milliard milliards
  pourcent moitié quart double triple
  cien ciento cientos mil miles millón millones millardo millardos billón
  mitad cuarto doble triple
  hundert tausend million millionen milliarde milliarden billion prozent
  hälfte viertel doppelt dreifach
  cem centos mil milhar milhares milhão milhões bilhão bilhões
  metade quarto dobro triplo
  cento centinaia mille mila milione milioni miliardo miliardi
  metà quarto doppio triplo
  مئة مائة ألف آلاف مليون ملايين مليار مليارات بالمئة بالمائة نصف ربع ضعف
`);

/**
 * Numbers written as words, one to twenty and the tens. Articles ("un",
 * "a") and words that are also grammar elsewhere (Italian "sei" and
 * "siete", Portuguese "dos", French "très" against "três") are left out.
 */
export const NUMBER_WORDS: ReadonlySet<string> = words(`
  zero one two three four five six seven eight nine ten eleven twelve
  thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty thirty
  forty fifty sixty seventy eighty ninety
  zéro deux trois quatre cinq six sept huit neuf dix onze douze treize
  quatorze quinze seize vingt trente quarante cinquante soixante
  cero cuatro cinco seis ocho nueve diez once doce trece catorce quince
  dieciséis veinte treinta cuarenta cincuenta sesenta
  null eins zwei drei vier fünf sechs sieben acht neun zehn elf zwölf
  dreizehn vierzehn fünfzehn zwanzig dreißig vierzig fünfzig sechzig
  zero dois duas quatro cinco seis sete oito nove dez onze doze treze
  catorze quinze vinte trinta quarenta cinquenta sessenta
  zero due tre quattro cinque sette otto nove dieci undici dodici
  tredici quattordici quindici venti trenta quaranta cinquanta sessanta
  صفر واحد اثنان اثنين ثلاثة أربعة خمسة ستة سبعة ثمانية تسعة عشرة عشرون
  ثلاثون أربعون خمسون ستون
`);

/** Words that join two facts into a cause, a sequence or a consequence. */
export const CAUSAL_CONNECTORS: ReadonlySet<string> = words(`
  because since so therefore thus hence due caused causing led leads result
  resulting thanks after following
  parce car donc puisque grâce cause entraîné conduit après suite
  porque pues debido causa gracias provocó llevó después tras
  weil denn deshalb daher wegen aufgrund führte nachdem
  porque pois portanto devido causa graças levou após depois
  perché poiché quindi dunque causa grazie dopo
  لأن بسبب لذلك نتيجة بعد إثر
`);

/** Words that hedge: what will, could or is hoped to happen. */
export const MODALS: ReadonlySet<string> = words(`
  will would could may might should must can shall likely possibly probably
  perhaps expected plan plans planned hope hopes aims
  pourrait pourraient devrait devraient peut peuvent va vont sera seront
  probablement espère prévoit
  podría podrían debería deberían puede pueden será serán probablemente quizá
  quizás espera prevé planea
  wird werden könnte könnten sollte sollten kann können wahrscheinlich
  vielleicht hofft plant
  poderia poderiam deveria pode podem será serão provavelmente talvez espera
  planeja
  potrebbe potrebbero dovrebbe può possono sarà saranno probabilmente forse
  spera
  قد سوف ربما يمكن سيكون ستكون
`);

/** Verbs of saying: the frame around a quotation, never its content. */
export const SAYING_VERBS: ReadonlySet<string> = words(`
  said says say told tells added adds explained explains recalled recalls
  describes described wrote writes according
  dit déclaré déclare raconte raconté explique expliqué ajoute ajouté affirme
  selon témoigne
  dijo dice contó cuenta explicó explica añadió añade afirma afirmó según
  relata
  sagte sagt erzählte erzählt erklärte erklärt fügte laut berichtet
  berichtete
  disse diz contou conta explicou explica acrescentou afirma afirmou segundo
  relata
  detto dice racconta raccontato spiega spiegato aggiunge afferma secondo
  قال قالت يقول تقول أضاف أضافت أوضح أوضحت بحسب وفق
`);

/**
 * Grammar words: articles, determiners, pronouns, prepositions,
 * coordinating conjunctions, auxiliaries and the commonest adverbs. Kept
 * clear of every list above (see the invariant in the header).
 */
export const STOP_WORDS: ReadonlySet<string> = words(`
  the a an this that these those some any each every all both either
  i me my mine we us our ours you your yours he him his she her hers it its
  they them their theirs who whom whose which what
  of in on at to from by with for about into onto over under between among
  through during before until up down off out across against toward towards
  upon within
  and or
  am is are was were be been being have has had having do does did done
  very also now today here there then still already again even more most
  much many such own same other another too as than
  le la les l un une des du de d au aux ce cet cette ces
  je tu il elle on nous vous ils elles me te se lui leur y en
  mon mes ton ta tes son sa ses notre nos votre vos leurs
  qui que quoi dont où
  à dans sur sous avec pour par chez vers entre parmi depuis pendant avant
  jusque jusqu contre
  et ou
  suis es est sommes êtes sont étais était étions étiez étaient été être
  ai as avons avez ont avais avait avions aviez avaient eu avoir
  fais fait faisons faites font faire
  très aussi maintenant aujourdhui ici là encore déjà toujours puis
  même autre autres tel telle tels telles
  el la los las lo un una unos unas del al
  yo tú él ella ello nosotros nosotras vosotros vosotras ellos ellas usted
  ustedes me te se nos os le les
  mi mis tu tus su sus nuestro nuestra nuestros nuestras vuestro vuestra
  que quien quienes cual cuales cuyo cuya
  a ante bajo con contra de desde en entre hacia hasta para por sobre
  y o u
  soy eres es somos sois son era eras éramos erais eran fui fue fuimos
  fueron sido ser estoy estás está estamos estáis están estaba estaban
  estuvo estado estar
  he has ha hemos habéis han había habían hubo haber
  muy también ahora hoy aquí allí ahí entonces aún ya
  mismo misma mismos mismas otro otra otros otras tal tales
  der die das des dem den ein eine einer eines einem einen
  ich du er sie es wir ihr mich mir dich dir ihm ihn uns euch ihnen
  mein meine meiner meinem meinen sein seine seiner seinem seinen unser
  unsere unserer unserem unseren euer eure
  dieser diese dieses diesem diesen jener jene jenes
  welcher welche welches wer wen wem wessen
  an auf aus bei für gegen hinter in mit nach neben über um unter von vor zu
  zwischen durch
  und oder
  bin bist ist sind seid war warst waren wart gewesen
  habe hast hat haben hatte hatten gehabt
  sehr auch jetzt heute hier dort dann noch schon immer bereits
  selbst gleich anders andere anderen anderer
  o a os as um uma uns umas do da dos das na nos nas ao à aos às
  eu tu ele ela nós vós eles elas você vocês me te se lhe lhes
  meu minha meus minhas teu tua teus tuas seu sua seus suas nosso nossa
  nossos nossas
  que quem qual quais cujo cuja
  de em por para com sobre sob entre contra desde até durante perante
  e ou
  sou és é somos sois são era eram fui foi fomos foram sido ser
  estou está estamos estão estava estavam esteve estado estar
  tenho tens tem temos têm tinha tinham teve ter
  hei há haver
  muito também agora hoje aqui ali aí então ainda já sempre
  mesmo mesma mesmos mesmas outro outra outros outras tal tais
  il lo la i gli le un uno una del dello della dei degli delle al allo alla
  ai agli alle dal dallo dalla dai dagli dalle nel nello nella nei negli
  nelle sul sullo sulla sui sugli sulle
  io tu lui lei noi voi loro mi ti si ci vi
  mio mia miei mie tuo tua tuoi tue suo sua suoi sue nostro nostra nostri
  nostre vostro vostra vostri vostre
  che chi cui quale quali
  di a da in con su per tra fra verso sotto sopra contro presso
  e o ed od
  sono sei è siamo siete ero eri era eravamo eravate erano stato stata
  stati state essere
  ho hai ha abbiamo avete hanno avevo avevi aveva avevano avuto avere
  molto anche ora adesso oggi qui qua lì là allora ancora già sempre
  stesso stessa stessi stesse altro altra altri altre tale tali
  في من إلى على عن مع حتى منذ لدى عند بين نحو أمام خلف فوق تحت حول لدي
  هذا هذه ذلك تلك هؤلاء أولئك هنا هناك هنالك
  أنا نحن أنت أنتم أنتن هو هي هم هن إياه إياها
  الذي التي الذين اللذان اللتان اللواتي اللاتي
  كان كانت كانوا كنا كنت يكون تكون يكونون كون
  ثم أو أم أي أيضا أيضاً جدا جداً الآن اليوم كل بعض ذات ذو ذي مثل كما
  إن أن إذا إذ حيث كيف متى أين ماذا لماذا
`);

/** Clause boundaries: the conjunctions a clause may start with. */
export const CLAUSE_CONJUNCTIONS: ReadonlySet<string> = union(
  CONTRAST_WORDS,
  words('and et y und e'),
  words('because since parce car porque weil perché لأن'),
  words('while whereas tandis alors mientras während enquanto mentre بينما'),
);

/** A period after one of these never ends a sentence. */
export const ABBREVIATIONS_ALWAYS: ReadonlySet<string> = words(`
  dr mr mrs ms prof st jr sr vs etc approx ca mme mlle sra dra ud uds sres
  bzw usw dott sig sigg fig vol pp
`);

/** A period after one of these ends no sentence when a digit follows. */
export const ABBREVIATIONS_BEFORE_NUMBER: ReadonlySet<string> = words(`
  no nr n art p fig vol ca approx num
`);

/**
 * "ولم" is "و" + "لم": Arabic writes "and", "so" as a one-letter prefix on
 * the next word, so a negator with one attached is looked up without it.
 */
function withoutArabicClitic(word: string): string | null {
  return word.length > 2 && (word[0] === 'و' || word[0] === 'ف')
    ? word.slice(1)
    : null;
}

/** `list` holds the word, or the word once an Arabic clitic is stripped. */
function listed(list: ReadonlySet<string>, word: string): boolean {
  if (list.has(word)) return true;
  const bare = withoutArabicClitic(word);
  return bare !== null && list.has(bare);
}

/** A negator, including the contracted forms "didn't", "n'avons" and "ولم". */
export function isNegatorWord(word: string): boolean {
  return (
    listed(NEGATORS, word) || word.endsWith("n't") || word.startsWith("n'")
  );
}

/** A word that narrows a claim ("only", "وفقط"). */
export function isScopeWord(word: string): boolean {
  return listed(SCOPE_CHANGERS, word);
}

/** A word that turns or narrows what it governs. */
export function isPolarityWord(word: string): boolean {
  return isNegatorWord(word) || isScopeWord(word);
}

/** A word that sets what follows against what came before ("but", "ولكن"). */
export function isContrastWord(word: string): boolean {
  return listed(CONTRAST_WORDS, word);
}

/** A word that names or scales a number: never allowed inside an insertion. */
export function isQuantityWord(word: string): boolean {
  return MAGNITUDE_WORDS.has(word) || NUMBER_WORDS.has(word);
}
