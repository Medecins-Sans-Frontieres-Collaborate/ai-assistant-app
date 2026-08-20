/**
 * Prompt builder for grant extraction.
 */
import {
  MEDICAL_ACTIVITIES_VOCAB,
  TERM_HIERARCHY,
} from '../lookups/termHierarchy';
import type { OCConfig } from '../ocConfig';

function getProjectNameInstructions(): string {
  return `
   - STANDARDIZATION RULES:
     a) Always translate to English if in another language
     b) Expand ALL acronyms (e.g., "PHC" -> "Primary Healthcare")
     c) REQUIRED format: "[Single Location or Region Name] [Main Medical Activity/Focus]"
        - CRITICAL: The location MUST be a SINGLE name — either one city/town OR one region/province
        - NEVER list multiple locations separated by commas, "and", or slashes
        - If the project operates in multiple specific locations, you MUST use a single broader regional or national-level name instead
          e.g., Fada, Matiacoali, Kompienga, Kantchari → use "Eastern Region" (NOT "Fada, Matiacoali, Kompienga and Kantchari")
          e.g., N'Djamena, Moyen-Chari, Salamat, Ouaddaï → use "Chad Multi-Region" or the most prominent single location
          e.g., Oudalan, Seno, Yagha, Soum → use "Sahel Region"
        - GOOD examples: "Eastern Region Primary and Secondary Healthcare", "Sahel Region Emergency Healthcare", "Kongoussi Displaced Populations Healthcare"
        - Additional GOOD examples: "Massakory Nutrition and Sexual and Reproductive Healthcare", "Maiduguri Emergency Nutrition Care", "Katsina Nutrition Care"
        - BAD examples: "N'Djamena, Moyen-Chari, Salamat and Ouaddaï Emergency Healthcare", "Fada and Matiacoali Healthcare" — NEVER list multiple locations
     d) Never use all-caps
     e) Always write "healthcare" as ONE WORD (not "health care")
     f) Common acronyms to expand: SRH=Sexual and Reproductive Health, TB=Tuberculosis, HIV=HIV/AIDS Care, MH=Mental Health, PHC=Primary Healthcare`;
}

function getProjectObjectiveInstructions(year: number): string {
  return `
   - Write ONE sentence describing the project's main purpose, target population, and location
   - Do NOT start with "Provide" — instead begin directly with the healthcare type or purpose
     e.g., "Maternal and neonatal care for women of reproductive age with pregnancy-related complications and newborns in Khost province, near Pakistan border with integrated sexual and reproductive health education and psychosocial support"
   - CRITICAL: Do NOT include the country name anywhere in the objective — not at the beginning, not at the end, not in any form. The country is already captured in a separate column. For example, write "Primary healthcare for displaced populations in Diffa Region" NOT "Primary healthcare for displaced populations in Diffa Region, Niger"
   - Do NOT list individual medical activities — they are captured in the Key Terms/Activities column
     Instead, use 1-2 high-level descriptors: "primary healthcare", "secondary healthcare", "emergency response", "mental health and psychosocial support"
   - Expand ALL acronyms — e.g., write "Dafra Medical Center with Surgical Unit" not "CMA de Dafra"
   - Use American English spelling and phrases — e.g., "operating room" not "operating theatre", "pediatric" not "paediatric", "organization" not "organisation"
   - Do NOT include closure, handover, end-of-project, or exit-strategy information in the objective. That is tracked separately from a supplemental source, not inferred from the narrative. Keep the objective to the project's purpose, target population, and location.
   - Keep it concise — one sentence maximum`;
}

function getGlobalTextRules(): string {
  return `
## GLOBAL TEXT RULES (apply to ALL fields):
- Always write "healthcare" as ONE WORD — never "health care". This applies everywhere: project names, objectives, activities, evidence citations.
- SPELLING NOTE: When writing the Event value that includes "healthcare exclusion", spell it as ONE WORD "healthcare" — NOT "health care".
- Always use American English spelling in all English-language output: "center" not "centre", "pediatric" not "paediatric", "program" not "programme", "organization" not "organisation", "operating room" not "operating theatre".
- These rules apply to Project Name, Project Objective, Key Terms/Activities, and the English citation in evidence. They do NOT apply to the original-language Supporting Text in evidence (which must be preserved exactly as written in the source document for search purposes).
`;
}

export function buildExtractionPrompt(
  ocCfg: OCConfig,
  year: number = 2026,
): string {
  const prevYear = year - 1;
  const vocabText = MEDICAL_ACTIVITIES_VOCAB.join(', ');

  const normalizationRules: string[] = [];
  for (const [canonical, triggers] of Object.entries(TERM_HIERARCHY)) {
    const triggersText = triggers.join(', ');
    normalizationRules.push(
      `- If you find any of these terms: "${triggersText}" → record as "${canonical}"`,
    );
  }
  const normalizationText = normalizationRules.join('\n');

  const codeRegex = ocCfg.code_regex;
  const ocName = ocCfg.name;
  const codePrefix = ocCfg.code_prefix || '';

  let codeHint: string;

  if (ocName === 'OCA') {
    codeHint = 'Format is P + 3-4 digit number (e.g., P1412, P987)';
  } else if (ocName === 'OCBA') {
    codeHint = `Format is ES + 2-letter country + 2-4 digit number (e.g., ESAF183, ESCD507). In OCBA documents the code is frequently written WITHOUT the "ES" prefix, and sometimes as ONLY the number — e.g. "CODE PROJET: NE110", "AF183", or "CÓDIGO DEL PROYECTO: 102". Return the code as country-letters + number: if the two country letters are already present, keep them; if ONLY the number is given, prepend the project country's ISO 3166-1 alpha-2 code (a project in Mexico numbered 102 → "MX102"; Niger 183 → "NE183"; note Niger=NE and Nigeria=NG differ). Do NOT add the "${codePrefix}" prefix yourself — it is applied automatically. NEVER discard a code just because it lacks the prefix.`;
  } else if (ocName === 'OCP') {
    codeHint =
      'Format is 2-letter country code + 2-4 digit number (e.g., AF110, CD507). One document may contain MULTIPLE projects.';
  } else if (ocName === 'WaCA') {
    codeHint =
      'Format is 2-3 letter code + optional W + 2-3 digit number (e.g., BF201, MLW12)';
  } else {
    codeHint =
      'Format is 2-letter country code + 2-4 digit number (e.g., AF101, BD112)';
  }

  // Multi-project examples in the OC's own code style, so e.g. OCB reviewers
  // don't see OCA's P-codes in their prompt. [code, aliasesJson] pairs feed
  // both the table/list illustration and the example JSON response. Only OCA
  // shows populated aliases (the real Myanmar case); other OCs show [] so the
  // example doesn't imply their documents are expected to define aliases.
  const exampleCodesByOC: Record<string, [string, string][]> = {
    OCA: [
      ['P1054', '["MKA"]'],
      ['P1055', '["MUS"]'],
    ],
    OCBA: [
      ['ESAF183', '[]'],
      ['ESNE110', '[]'],
    ],
    WaCA: [
      ['BF201', '[]'],
      ['MLW12', '[]'],
    ],
  };
  const [exA, exB] = exampleCodesByOC[ocName] || [
    ['AF183', '[]'],
    ['AF101', '[]'],
  ];
  const tableExampleByOC: Record<string, string> = {
    OCA: '"P1054 Kachin State IDP Healthcare", "P1055 Shan State ..."',
    OCBA: '"ESAF183 Khost Maternal and Neonatal Healthcare", "ESNE110 ..."',
    WaCA: '"BF201 Bobo-Dioulasso Healthcare", "MLW12 ..."',
  };
  const tableExample =
    tableExampleByOC[ocName] ||
    '"AF183 Khost Maternal and Neonatal Healthcare", "AF101 ..."';

  const exampleDoc =
    ocName === 'OCB'
      ? {
          code: 'NG110',
          name: 'Maiduguri Emergency Nutrition Care',
          objective:
            'Large-scale malnutrition prevention and treatment, operating ITFCs and ATFCs and supporting malaria and epidemic response in Maiduguri, Borno State.',
          atfcQuote:
            'We will maintain the four current ATFCs across the LGAs and one ITFC, activating the second ITFC during the malnutrition peak.',
        }
      : {
          code: 'NG162',
          name: 'Katsina Nutrition Care',
          objective:
            'Large-scale malnutrition prevention and treatment, operating ITFCs and ATFCs and supporting malaria and epidemic response in Katsina State.',
          atfcQuote:
            "We will maintain four out of 5 current ATFCs in the three (3) LGAs (1 in Katsina 2 in Jibia and 1 in Mashi). 1 ITFC in (Kofar Sauri) and the second ITFC Turai Yar'Adua Hospital during the peak.",
        };

  let multiProjectSection = `
## MULTIPLE PROJECTS IN ONE DOCUMENT
FIRST, scan the ENTIRE document for EVERY distinct project code (a token matching the code pattern
"${codeRegex}"). The number of DISTINCT project codes = the number of projects to return.
- Exactly ONE distinct code -> return a SINGLE JSON object (the schema below).
- MORE THAN ONE distinct code -> the document describes MULTIPLE projects and you MUST extract EVERY
  one: return {"projects": [ ... ]} with ONE object per distinct code, each following the FULL schema.
Multiple codes can appear in several forms — treat ALL of these as multi-project:
  * a combined title or heading ("BD112 & BD114", "NG110 NG109", "SL-125 / SL-124", "UA120-121-122");
  * separate sections/pages, one per project;
  * a TABLE or LIST where each code sits beside its own project name, location, or budget line
    (e.g. ${tableExample}, each with its own budget).
Be exhaustive — a missed project code is a missed project. But do NOT invent projects, do NOT split
a single project (one code) into several, and do NOT merge distinct codes into one.

ATTRIBUTION (critical when a document covers multiple projects/cost-centers): assign each activity, objective,
location, and budget line ONLY to the specific project it belongs to. A service counts for a project ONLY if that
project's own section, row, or budget line marks it. Do NOT copy one project's services onto another, and do NOT
give every project the union of all services in the document. Two projects that share a combined narrative or
heading (e.g. "SL124 & SL125") must still be differentiated by their individual details — never emit identical
rows for distinct codes.

PROJECT ALIASES (how multi-cost-center documents usually mark attribution): such documents typically define a
short alias or site abbreviation for each project code once, near the top — e.g. a cover table listing
"P1054 Kachin State IDP Health Care (MKA)", "P1756 Hpakant Healthcare (HPK)", "P1072 Eastern Primary
Healthcare WGM(LZ)" — and the body then references projects ONLY by alias ("a new Mental Health Supervisor
will be recruited in MKA"). You MUST:
  1. Build the code-to-alias map from wherever the document introduces it (cover table, header, project list).
  2. Resolve every alias-labeled activity, section, location, or budget line to that alias's project code and
     attribute it there — an alias label IS that project's marker.
  3. A sentence naming several aliases (e.g. "in MKA, HPK and MUS") counts for EACH of those projects.
Never leave a project without activities merely because its sections are labeled with the alias instead of the
code — resolve the alias FIRST, then attribute. Do not treat an alias as a separate project.
QUOTE INTEGRITY: never alter a place name, alias, or site abbreviation inside a quote — "quote_original" is copied character-for-character from the document, and "quote_english" must faithfully render it WITHOUT substituting a different project's location or alias. Changing "in WGM(LZ)" to "in MUS" is falsification.
In EVERY project object include "project_aliases": an array of the EXACT alias strings the document uses for
that project (e.g. ["MKA"]), or [] if the document defines none. Evidence discipline: every quote you attach to
a project must come from that project's own text — a sentence labeled with ANOTHER project's alias is NOT
evidence for this one, even for an activity both projects perform.

Example multi-project response:
\`\`\`json
{
    "document_type": "project narrative",
    "projects": [
        {"project_code": "${exA[0]}", "project_name": "...", "project_aliases": ${exA[1]}, ...},
        {"project_code": "${exB[0]}", "project_name": "...", "project_aliases": ${exB[1]}, ...}
    ]
}
\`\`\`
`;
  if (ocCfg.multi_project) {
    multiProjectSection += `
NOTE: ${ocName} frequently submits country-level documents that cover MANY projects at once — expect several projects per document and be exhaustive.
`;
  }

  const nameInstructions = getProjectNameInstructions();
  const objectiveInstructions = getProjectObjectiveInstructions(year);
  const globalRules = getGlobalTextRules();

  const FOCUS_EXAMPLES: [string, [string, string, string][]][] = [
    [
      'Nutrition',
      [
        [
          'P1397',
          'Massakory Nutrition and Sexual and Reproductive Healthcare',
          'OCA',
        ],
        ['NG110', 'Maiduguri Emergency Nutrition Care', 'OCB'],
        ['NG162', 'Katsina Nutrition Care', 'OCP'],
      ],
    ],
    [
      'Refugees/IDPs',
      [
        ['P1005', 'Kutupalong Rohingya Refugee Secondary Healthcare', 'OCA'],
        ['P1188', 'Central Mediterranean Search and Rescue', 'OCA'],
        ['P1642', 'Gaza IDP Response', 'OCA'],
        ['TD180', 'Adré Primary Healthcare for Sudanese Refugees', 'OCG'],
        [
          'BD112',
          "Medical Humanitarian Response for Rohingya Refugees in Cox's Bazaar - Jamtoli camp",
          'OCB',
        ],
        [
          'MZ142',
          'Access to health care in conflict in Cabo Delgado province (host population and IDPs) - Macomia',
          'OCB',
        ],
        ['BI110', 'Réfugiés Congolais Ruyigi', 'OCB'],
        ['BE114', 'Migration Health Belgium', 'OCB'],
      ],
    ],
    ['Mental health', [['PI120', 'Nablus Mental Health and SGBV Care', 'OCP']]],
    [
      'Maternal health',
      [
        ['AF183', 'Khost Maternal and Neonatal Healthcare', 'OCB'],
        ['SS153', 'Aweil State Maternity and Pediatrics Hospital', 'OCP'],
      ],
    ],
    [
      'Pediatrics',
      [
        ['CF144', 'Bria Pediatric Primary and Secondary Healthcare', 'OCP'],
        [
          'SL125',
          'Paediatric and maternal healthcare in Hangha Hospital - Kenema',
          'OCB',
        ],
      ],
    ],
    [
      'Climate impact',
      [
        ['P1624', 'Afghanistan Environmental Impact Project', 'OCA'],
        ['P1709', 'Nigeria Environmental Impact Project', 'OCA'],
        ['P1798', 'South Sudan Environmental Impact Project', 'OCA'],
        [
          'CF123',
          'Regional Climate, Environment and Health Roadmap - Green Initiative',
          'OCB',
        ],
        ['MG161', 'Ikongo Planetary Health', 'OCG'],
      ],
    ],
  ];
  // OCA's tested baseline list, kept byte-identical: entries added later for
  // other OCs do not appear in OCA's prompt.
  const OCA_LEGACY_EXAMPLES = new Set([
    'P1397',
    'NG110',
    'NG162',
    'P1005',
    'P1188',
    'P1642',
    'TD180',
    'PI120',
    'AF183',
    'SS153',
    'CF144',
    'P1624',
    'P1709',
    'P1798',
    'CF123',
    'MG161',
  ]);
  const focusLines: string[] = [];
  for (const [area, examples] of FOCUS_EXAMPLES) {
    const kept =
      ocName === 'OCA'
        ? examples.filter(([c]) => OCA_LEGACY_EXAMPLES.has(c))
        : examples.filter(([, , owner]) => owner === ocName);
    if (kept.length === 0) continue;
    focusLines.push(`- ${area}:`);
    for (const [c, n] of kept)
      focusLines.push(`  * Project Code: ${c}, Project Name: ${n}`);
  }
  const focusExamplesSection =
    focusLines.length > 0
      ? `Good examples by focus area (each example is a real project, shown as its Project Code and Project Name):\n${focusLines.join('\n')}\n`
      : '';

  // Using template literal with double-brace escaping for JSON examples
  const prompt = `You are an expert data extractor for MSF (Médecins Sans Frontières) grant documents.

Your task is to extract structured project information and identify medical activities PLANNED FOR ${year}.

${globalRules}

## ${year} ACTIVITIES — BE EXHAUSTIVE, BUT ${year}-SCOPED
The document is a plan for the year ${year}. Capture EVERY medical service the project will deliver, continue, or start in ${year} — completeness matters as much as accuracy. Under-listing (dropping services the document actually describes) is a common and serious error; be thorough.
- The document MUST contain the literal string "${year}" somewhere for you to extract any activities. If the year ${year} does not appear ANYWHERE in the document text, return "no ${year} or current year activities found" instead of an activities list.
- Many documents include a SERVICES TABLE comparing the previous year and ${year} (rows/columns marked "Yes"/"Oui"/"Sí"/"${year}", "new in ${year}", "continues in ${year}", or "NON→OUI"). EVERY service marked as provided, planned, continuing, or new for ${year} in such a table IS an activity — extract ALL of them.
- A service the project is currently delivering and will CONTINUE counts for ${year} unless the document says it ends BEFORE ${year}. You do NOT need the literal year printed next to each service: if the document's planning horizon is ${year} and the service is part of the ${year} package (objectives, services table, "prospects for next year", logframe), include it.
- A project described only for ${prevYear}, with no indication it continues, does NOT automatically extend to ${year}.
- PRECISION GUARDS — do NOT include an activity if ANY of these apply:
  * It is aspirational, conditional, or not yet secured — e.g. "ambition to", "hope to", "if approved", "if funded", "plan to introduce (pending approval)", "may be added". Extract only services that will actually be delivered in ${year}.
  * It is delivered by SOMEONE ELSE, not this project — e.g. the project only refers patients out, or the service is provided by UNICEF / the Ministry of Health / another actor while MSF only advocates, coordinates, or supports.
  * It belongs to a DIFFERENT year (explicitly ${prevYear} or earlier, already achieved, or closed).
  * It is an operational/administrative side-detail of a medical project (see the MEDICAL vs NON-MEDICAL rule below). For a document whose purpose is non-medical (green initiative, construction, coordination, learning initiative), the substantive non-medical activities DO count.
- Do NOT invent services. Every activity must trace to a specific passage in THIS project's own section.

${multiProjectSection}

## FIELDS TO EXTRACT:

1. **project_code** (REQUIRED): The unique project identifier
   - ${codeHint}
   - Regex pattern: ${codeRegex}
   - Look for: "Project Code", "Code du projet", "Project Number"

2. **project_name** (REQUIRED): The full title of the project
   - Look for: "Title of the Project", "Project Name", "Titre du projet"
   - Green Initiative submission forms label the title "Initiative Name:" — treat that as the project name
   - If no explicit label is present, use the most prominent title/heading of the project — including a heading or text box at the top of the document or section. For documents that contain multiple projects, the project name is the heading at the start of each project's section.
   - STANDARDIZATION RULES FOR PROJECT NAME:
${nameInstructions}

3. **country** (REQUIRED): The country where the project operates
   - Look for: "Mission", "Country", "Pays", country names in title
   - STANDARDIZATION: Always use the standard English country name:
     * "République démocratique du Congo" or "Democratic Republic of Congo" or "DRC" → "DRC"
     * "Côte d'Ivoire" → "Ivory Coast"
     * "Tchad" → "Chad"
     * "République centrafricaine" or "RCA" → "Central African Republic"
     * "Soudan du Sud" → "South Sudan"
     * Always use full English names, no abbreviations or French names

4. **start_date**: Return "" — project start dates are NOT taken from the narrative. They are
   supplied by a separate supplemental dates file and joined to each project by code after
   extraction; a project not covered by that file is reported as "No date found".

5. **end_date**: Return "" — same as start_date, the supplemental dates file is the only source.

6. **activities_${year}** (REQUIRED): ${year} activities only. 2-5 word concise labels.
   - Use HIGH-LEVEL category names from this reference vocabulary: ${vocabText}
   - Extract EVERY distinct medical service category the project delivers — be thorough and exhaustive.
   - List each distinct service SEPARATELY. Do NOT let a broad category swallow a distinctly-provided service: if the project provides Neonatology, SGBV / sexual-violence care, Surgery, SRH, or Mental Health IN ADDITION to Maternal Health or Primary Healthcare, list EACH one separately — never fold them into a single broad label.
   - Each label must be a SHORT canonical category name only: NO parenthetical detail, NO commas inside a label, NO age ranges or sub-lists. Write "Maternal Health" (NOT "Maternal Health (ANC, PNC, Contraception)"), "Inpatient Care" (NOT "Inpatient Care (<5 years)"), "Vaccination" (NOT "Vaccination (Mass Campaigns)"). Put specifics in the evidence quote, not the label.
   - FINAL CHECK before you finish — scan the document once more for these frequently-provided but frequently-MISSED ${year} services, and include every one that is documented for THIS project: Maternal Health, SRH, Neonatology, SGBV / sexual-violence care, Surgery (including obstetric/C-section surgery), Nutrition (ITFC/ATFC), Vaccination, Mental Health / MHPSS, HIV, TB, NCDs, Malaria, WatSan, Emergency Care, Inpatient Care, Referral Services.
   - GOOD: "Maternal Health", "Neonatology", "Vaccination", "Mental Health", "Nutrition", "Surgery", "SRH", "HIV", "TB", "SGBV", "Palliative Care"
   - BAD: "Kangaroo Mother Care" (technique within Maternal Health — use "Maternal Health"), "Antimicrobial Stewardship" (operational protocol), "Capacity Building" (operational), "Biomedical Sustainability" (operational)
   - MEDICAL vs NON-MEDICAL: for a medical project narrative, the activities list is its distinct MEDICAL service lines — do not pad it with the operational/administrative side-details every project has (logistics, HR, admin, supply chain). But when the document's PURPOSE is non-medical — a green/environmental initiative, construction or infrastructure work, a coordination office, a learning/training initiative — its substantive activities ARE the activities: report them as concise labels (e.g. "Solar Power Installation", "Waste Management", "Staff Training Program") rather than forcing medical labels onto them or leaving the list empty.
   - When the document describes a broad package, expect 8-15 activities — if a project provides many medical services, list them ALL. Under-listing is a common and serious error.

7. **evidence**: For EACH activity, provide citation evidence with TWO quotes:
   - **section**: The section name where the activity was found
   - **quote_english**: MUST be in English - if document is in French/Spanish/other, TRANSLATE this quote to English
   - **quote_original**: The text COPIED VERBATIM (character-for-character) from the document, exactly as it appears, so it can be found with Ctrl+F in the source. Use the language the document is ACTUALLY written in. IMPORTANT: many documents are written in ENGLISH even for French/Spanish-speaking countries — in that case quote_original is English and IDENTICAL to quote_english. Only when the document itself is written in another language is quote_original in that language. NEVER translate, paraphrase, localize, or reconstruct this field: do NOT translate quote_english into the country's language. If you cannot copy a verbatim matching passage from the document, leave it identical to quote_english (copy the English) — never invent text that is not physically in the document.
   - Example — document written in ENGLISH (even for a francophone country like Burkina Faso):
     * quote_english: "Free, high-quality community healthcare for people in hard-to-reach villages."
     * quote_original: "Free, high-quality community healthcare for people in hard-to-reach villages."   (IDENTICAL — the document is in English, so do NOT invent a French version)
   - Example — document written in FRENCH:
     * quote_english: "Strengthen mental healthcare activities with focus on identification and referral of cases at IDP sites."
     * quote_original: "Renforcement des activités de soins de santé mentale avec focus sur l'identification et orientation des cas au niveau des sites IDPs."

8. **project_objective** (REQUIRED): One sentence about the project's main objective/focus and location
${objectiveInstructions}

9. **is_new_project**: Return "no" — new-project status is NOT taken from the narrative. It is
    determined from supplemental files after extraction: a project classified as Regular (not
    Emergency) in the project classifications file whose ops start date (from the supplemental
    dates file) falls in ${year} is a new project.

10. **is_emergency_project**: Return "no" — emergency status is NOT taken from the narrative. It is
    determined by the supplemental classifications file (Regular/Emergency); projects not listed
    there default to "no".

11. **is_closing_project**: Return "no" — closing status is NOT taken from the narrative. It is
    determined from supplemental files: a project classified as Regular whose ops end date (from
    the supplemental dates file) falls in ${year} is closing; Emergency projects and projects not
    listed in the files are not.

12. **is_community_centered**: Is this project primarily community-based or patient-centered in its delivery model? (yes/no)
    - "yes" if the project document describes delivering healthcare through a community-centered approach that ensures medical operations are both responsive to local needs and aligned with MSF's commitment to people-centered, context-sensitive, and culturally appropriate approaches that strengthen community agency and dignity.
    - "no" otherwise

13. **context**: Return "" — the operating context is NOT interpreted from the narrative. It will be
    supplied by a supplemental file and joined to each project by code after extraction.

14. **event**: Return "" — the event category is NOT interpreted from the narrative. It will be
    supplied by a supplemental file and joined to each project by code after extraction.

15. **population_type**: Return "" — the population type is NOT interpreted from the narrative. It
    will be supplied by a supplemental file and joined to each project by code after extraction.

## THEMATIC FOCUS FIELDS (yes/no — primary focus only):
Answer "yes" ONLY if the thematic area is a PRIMARY, DEFINING purpose of the project — not merely one activity among many. These flags identify SPECIALIZED projects, not general hospitals that happen to offer a service.

KEY RULE: A general/referral hospital or multi-service healthcare project that offers maternity, pediatrics, nutrition, surgery, etc. as PART of its comprehensive services → ALL thematic flags should be "no". These flags are ONLY for projects where one thematic area IS the project's identity.

Examples:
- A referral hospital with maternity ward, pediatrics, surgery, nutrition, and emergency care = focuses_on_maternal_health: "no", focuses_on_pediatrics: "no", focuses_on_nutrition: "no" (it's a GENERAL hospital, not a specialized project)
- A project SPECIFICALLY focused on maternal/reproductive healthcare (e.g., "Khost Maternity and Neonatal Healthcare") = focuses_on_maternal_health: "yes"
- A general primary/secondary healthcare project that includes mental health consultations = focuses_on_mental_health: "no"
- A DEDICATED mental health and psychosocial support project = focuses_on_mental_health: "yes"
- A pediatric inpatient care project = focuses_on_pediatrics: "yes"
- focuses_on_refugees_idps: "yes" if displaced populations (refugees, IDPs, displaced) are an explicitly NAMED target group in the project description, even if the project also serves the general population

16. **focuses_on_nutrition** 17. **focuses_on_refugees_idps** 18. **focuses_on_mental_health**
19. **focuses_on_maternal_health** 20. **focuses_on_pediatrics** 21. **focuses_on_climate_impact**

${focusExamplesSection}
22. **document_type** (REQUIRED): Classify what KIND of document this is, based on its OVERALL purpose (this describes the DOCUMENT, not the project):
    - "project narrative" — a dedicated proposal / annual plan whose primary purpose is to describe the actual project(s), including a country document that IS the project submission with per-project detail. This is the normal case.
    - "coordination" — a mission or national coordination / management document (e.g. "Coordination Nationale", mission analysis) that frames the mission rather than proposing a specific project.
    - "strategy" — a strategic plan or strategy paper.
    - "overview" — a high-level country or portfolio overview/summary that mainly references projects documented in detail elsewhere.
    - "compilation" — a single file bundling many separate project fiches.
    - "green initiative" — a Green Initiative submission form (environmental/climate initiative proposal, often titled "Green Initiatives <year>" with an "Initiative Name:" field).
    - Or a short lowercase label of your own if none fit (e.g. "situation report", "budget annex").
    Use "project narrative" whenever the document's main purpose is to propose or describe the actual project(s); use the others only when the document is primarily a mission/strategy/overview/summary. For a multi-project response, put document_type ONCE at the TOP LEVEL next to "projects".

## OUTPUT FORMAT (JSON):

\`\`\`json
{
    "document_type": "project narrative",
    "project_code": "${exampleDoc.code}",
    "project_name": "${exampleDoc.name}",
    "country": "Nigeria",
    "start_date": "",
    "end_date": "",
    "project_objective": "${exampleDoc.objective}",
    "is_new_project": "no",
    "is_emergency_project": "no",
    "is_closing_project": "no",
    "is_community_centered": "no",
    "context": "",
    "event": "",
    "population_type": "",
    "focuses_on_nutrition": "yes",
    "focuses_on_refugees_idps": "no",
    "focuses_on_mental_health": "no",
    "focuses_on_maternal_health": "no",
    "focuses_on_pediatrics": "no",
    "focuses_on_climate_impact": "no",
    "activities_${year}": [
        {
            "activity": "Nutrition (ITFC, ATFC)",
            "section": "Prospects for next year(s)",
            "quote_english": "${exampleDoc.atfcQuote}",
            "quote_original": "${exampleDoc.atfcQuote}"
        },
        {
            "activity": "Epidemics Preparedness (Cholera, Measles, Meningitis)",
            "section": "Prospects for next year(s)",
            "quote_english": "Support and strengthen response to epidemics (Cholera, Measles, Diphtheria, Meningitis, etc.).",
            "quote_original": "Support and strengthen response to epidemics (Cholera, Measles, Diphtheria, Meningitis, etc.)."
        },
        {
            "activity": "Outpatient Care",
            "section": "Prospects for next year(s)",
            "quote_english": "Continuing and enforcing the provision of OPD, family planning services, SV and SCA services for every person accessing the facility.",
            "quote_original": "Continuing and enforcing the provision of OPD, family planning services, SV and SCA services for every person accessing the facility."
        },
        {
            "activity": "Mental Health",
            "section": "Prospects for next year(s)",
            "quote_english": "Maintain and strengthen the medico and psychosocial support for mothers in the ITFC.",
            "quote_original": "Maintain and strengthen the medico and psychosocial support for mothers in the ITFC."
        },
        {
            "activity": "Physical Therapy",
            "section": "Prospects for next year(s)",
            "quote_english": "broaden physiotherapy services focusing on patients with nutritional oedema, maintain specific hospitalization ward for SAM with 3+ oedema.",
            "quote_original": "broaden physiotherapy services focusing on patients with nutritional oedema, maintain specific hospitalization ward for SAM with 3+ oedema."
        }
    ]
}
\`\`\`

## IMPORTANT RULES:
1. Each activity MUST have a supporting quote that can be found via Ctrl+F
2. Quotes should be 1-2 sentences max, directly mentioning the activity
3. If the document is in French/Spanish/other, translate activity names and quote_english to English, but quote_original must be the VERBATIM source text as physically written in the document. Do NOT translate quote_english into another language to fill quote_original — copy only text that actually appears in the document (so Ctrl+F finds it). If the document is in English, quote_original is English and identical to quote_english.
4. Return "not found" for optional fields if the information is not found in the document
5. If the year ${year} does not appear ANYWHERE in the document text, OR no ${year}-specific activities are described, return "no ${year} or current year activities found" instead of an activities list. Do NOT populate it with activities from other years.
6. Activities are the project's SUBSTANTIVE work. For MEDICAL project narratives that means MEDICAL SERVICE DELIVERY — do NOT pad the list with operational/administrative side-details (capacity building, training, advocacy, stewardship, logistics, supply chain management). For documents whose purpose is NON-MEDICAL, report the substantive non-medical activities the document describes:
   - environmental impact (e.g. "Solar Power Installation", "Waste Management", "Energy Efficiency", "Water Conservation")
   - construction (e.g. "Facility Construction", "Facility Rehabilitation", "Infrastructure Upgrade")
   - learning and development (e.g. "Staff Training Program", "Clinical Mentorship", "E-Learning Development")
   Being non-medical is NOT a reason to exclude a project's core activities.

## TERM NORMALIZATION (apply AFTER extracting all activities):
For specific trigger terms, use the canonical term instead:

${normalizationText}

NORMALIZATION RULES:
- If multiple triggers map to the same canonical term, list the canonical term only ONCE
- Use the reference vocabulary wherever possible — prefer canonical terms over inventing new labels

Now extract from this document:

---
OC: ${ocName}
Project code pattern: ${codeRegex}

DOCUMENT TEXT:
---

`;
  return prompt;
}
