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

function getClosingProjectInstructions(year: number): string {
  return `
    Answer with one of these exact values:
    - "no" — the project is NOT closing in ${year}
    - "full_closure" — the ENTIRE project will permanently cease ALL activities by end of ${year} or activities are being fully handed over to local authorities/MoH
    - "handover_to_oc" — the ENTIRE project is being transferred to another MSF operational center (e.g., "handover to OCB")
    - "partial_handover" — the project is reorienting (e.g., shifting from hospital to primary healthcare) or partially handing over some activities while continuing others under the same OC

    Important distinctions:
    - "full_closure" = MSF completely stops ALL activities at this location
    - "handover_to_oc" = project continues but under a different MSF OC
    - "partial_handover" = project continues under same OC but with significant scope changes or partial activity transfers
    - "no" = project continues as normal, including standard capacity building or sustainability planning

    If only SPECIFIC activities are transitioning while the project broadly continues, answer "no"
    If the project is expanding or adding new activities, answer "no" `;
}

function getRemoteManagementInstructions(): string {
  return `
    - "yes" ONLY if the document explicitly states that the ENTIRE project is CURRENTLY managed remotely as its operational model
    - "no" for partial remote management, plans, preparations, toolkits, training, or if only a sub-component is remote
    - "no" if "remote" is used in other contexts (e.g., "remote communities", "remote areas")

    **remote_management_notes**: If there is ANY mention of remote management — even partial, planned, or for specific components — describe it briefly here. Return null if no mentions at all.
    - Examples: "Foumban component operated remotely without MSF presence", "Remote management toolkit being developed", "Training on remote management for supervisors planned"
    - This field captures all remote management references for review, even when has_remote_management is "no" `;
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
    (e.g. "P1054 Kachin State IDP Healthcare", "P1055 Shan State ...", each with its own budget).
Be exhaustive — a missed project code is a missed project. But do NOT invent projects, do NOT split
a single project (one code) into several, and do NOT merge distinct codes into one.

ATTRIBUTION (critical when a document covers multiple projects/cost-centers): assign each activity, objective,
location, and budget line ONLY to the specific project it belongs to. A service counts for a project ONLY if that
project's own section, row, or budget line marks it. Do NOT copy one project's services onto another, and do NOT
give every project the union of all services in the document. Two projects that share a combined narrative or
heading (e.g. "SL124 & SL125") must still be differentiated by their individual details — never emit identical
rows for distinct codes.

Example multi-project response:
\`\`\`json
{
    "document_type": "project narrative",
    "projects": [
        {"project_code": "P1054", "project_name": "...", ...},
        {"project_code": "P1055", "project_name": "...", ...}
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
  const closingInstructions = getClosingProjectInstructions(year);
  const remoteInstructions = getRemoteManagementInstructions();
  const globalRules = getGlobalTextRules();

  // Using template literal with double-brace escaping for JSON examples
  const prompt = `You are an expert data extractor for MSF (Médecins Sans Frontières) grant documents.

Your task is to extract structured project information and identify medical activities PLANNED FOR ${year}.

${globalRules}

## ${year} ACTIVITIES — BE EXHAUSTIVE, BUT ${year}-SCOPED
The document is a plan for the year ${year}. Capture EVERY medical service the project will deliver, continue, or start in ${year} — completeness matters as much as accuracy. Under-listing (dropping services the document actually describes) is a common and serious error; be thorough.
- The document MUST contain the literal string "${year}" somewhere for you to extract any activities. If the year ${year} does not appear ANYWHERE in the document text, return an empty activities_${year} array.
- Many documents include a SERVICES TABLE comparing the previous year and ${year} (rows/columns marked "Yes"/"Oui"/"Sí"/"${year}", "new in ${year}", "continues in ${year}", or "NON→OUI"). EVERY service marked as provided, planned, continuing, or new for ${year} in such a table IS an activity — extract ALL of them.
- A service the project is currently delivering and will CONTINUE counts for ${year} unless the document says it ends BEFORE ${year}. You do NOT need the literal year printed next to each service: if the document's planning horizon is ${year} and the service is part of the ${year} package (objectives, services table, "prospects for next year", logframe), include it.
- A project described only for ${prevYear}, with no indication it continues, does NOT automatically extend to ${year}.
- PRECISION GUARDS — do NOT include an activity if ANY of these apply:
  * It is aspirational, conditional, or not yet secured — e.g. "ambition to", "hope to", "if approved", "if funded", "plan to introduce (pending approval)", "may be added". Extract only services that will actually be delivered in ${year}.
  * It is delivered by SOMEONE ELSE, not this project — e.g. the project only refers patients out, or the service is provided by UNICEF / the Ministry of Health / another actor while MSF only advocates, coordinates, or supports.
  * It belongs to a DIFFERENT year (explicitly ${prevYear} or earlier, already achieved, or closed).
  * It is operational/non-medical (see the rules below).
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

3. **mission_country** (REQUIRED): The country where the project operates
   - Look for: "Mission", "Country", "Pays", country names in title
   - STANDARDIZATION: Always use the standard English country name:
     * "République démocratique du Congo" or "DRC" → "Democratic Republic of Congo"
     * "Côte d'Ivoire" → "Ivory Coast"
     * "Tchad" → "Chad"
     * "République centrafricaine" or "RCA" → "Central African Republic"
     * "Soudan du Sud" → "South Sudan"
     * Always use full English names, no abbreviations or French names

4. **start_date**: Project start date (format: YYYY-MM-DD or as found)
   - Look for: "Start date", "Date de début"

5. **end_date**: Project end date (format: YYYY-MM-DD or as found)
   - Look for: "End date", "Date de fin", "Estimated End date"
   - If end date field contains placeholder text like "Click here to enter a date" or is empty, use "ongoing"
   - If no end date is mentioned AND project is active in ${year}, use "ongoing"

6. **activities_${year}** (REQUIRED): ${year} activities only. 2-5 word concise labels.
   - Use HIGH-LEVEL category names from this reference vocabulary: ${vocabText}
   - Extract EVERY distinct medical service category the project delivers — be thorough and exhaustive.
   - List each distinct service SEPARATELY. Do NOT let a broad category swallow a distinctly-provided service: if the project provides Neonatology, SGBV / sexual-violence care, Surgery, SRH, or Mental Health IN ADDITION to Maternal Health or Primary Healthcare, list EACH one separately — never fold them into a single broad label.
   - Each label must be a SHORT canonical category name only: NO parenthetical detail, NO commas inside a label, NO age ranges or sub-lists. Write "Maternal Health" (NOT "Maternal Health (ANC, PNC, Contraception)"), "Inpatient Care" (NOT "Inpatient Care (<5 years)"), "Vaccination" (NOT "Vaccination (Mass Campaigns)"). Put specifics in the evidence quote, not the label.
   - FINAL CHECK before you finish — scan the document once more for these frequently-provided but frequently-MISSED ${year} services, and include every one that is documented for THIS project: Maternal Health, SRH, Neonatology, SGBV / sexual-violence care, Surgery (including obstetric/C-section surgery), Nutrition (ITFC/ATFC), Vaccination, Mental Health / MHPSS, HIV, TB, NCDs, Malaria, WatSan, Epidemic/Outbreak Response, Emergency Care, Inpatient Care, Referral Services.
   - GOOD: "Maternal Health", "Neonatology", "Vaccination", "Mental Health", "Nutrition", "Surgery", "SRH", "HIV", "TB", "SGBV", "Palliative Care"
   - BAD: "Kangaroo Mother Care" (technique within Maternal Health — use "Maternal Health"), "Antimicrobial Stewardship" (operational protocol), "Capacity Building" (operational), "Biomedical Sustainability" (operational)
   - Include ALL distinct medical service lines but NOT operational/administrative details
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

9. **is_new_project**: Is this a new project? (yes/no)
    - "yes" if the project is described as new, recently launched, starting in ${prevYear}/${year}, or in its first year
    - Look for: "new project", "newly established", "launched in", "starting", "first year", "pilot"
    - "no" if the project has been running for multiple years or is established

10. **is_emergency_project**: Is this an emergency response project? (yes/no)
    - "yes" ONLY if the project was LAUNCHED AS an emergency response, crisis response, or disaster response — i.e., the entire project exists to respond to an acute emergency
    - "no" for ongoing/established medical projects that include emergency response CAPACITY or preparedness as one component
    - "no" for general hospitals or healthcare projects in conflict zones — operating in a conflict area does NOT make a project an "emergency project"
    - A referral hospital that maintains emergency preparedness and responds to outbreaks = "no" (it's a general healthcare project)
    - A project deployed specifically to respond to a cholera outbreak or earthquake = "yes"

11. **is_closing_project**: Is this project closing or being handed over?
${closingInstructions}

12. **has_remote_management**: Does this project involve remote management? (yes/no)
${remoteInstructions}

13. **is_community_centered**: Is this project primarily community-based or patient-centered in its delivery model? (yes/no)
    - "yes" if the project document describes delivering healthcare through a community-centered approach — care delivered primarily through community structures and responsive to local needs, consistent with MSF's commitment to people-centered, context-sensitive, and culturally appropriate care that strengthens community agency and dignity.
    - Concrete examples of community-centered approaches (any of these as the PRIMARY delivery model indicates "yes"):
      * Community health workers (CHWs) delivering or supervising care
      * Mobile clinics or outreach teams bringing care into communities
      * Home-based or door-to-door care
      * Decentralized care delivered at the village/community level rather than at a central facility
      * Community-led case finding, referral, or health promotion as the project's core strategy
    - "no" if the project is primarily facility-based (hospital, clinic, health center) even if it includes some community activities like health promotion or outreach
    - The key question: WHERE is care primarily delivered — in facilities, or in communities?

14. **context**: ONE of: "Armed Conflict", "Internal Instability", "Post-Conflict", "Stable"

15. **event**: ONE of: "Population affected by endemics/epidemics", "Population affected by natural disaster", "Population affected by social violence and healthcare exclusion", "Victims of armed conflict"

16. **population_type**: ONE of: "Displaced", "General Population", "Mixed Displaced/General", "Victims of Natural Disasters"

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

17. **focuses_on_nutrition** 18. **focuses_on_refugees_idps** 19. **focuses_on_mental_health**
20. **focuses_on_maternal_health** 21. **focuses_on_pediatrics** 22. **focuses_on_climate_impact**

Good examples by focus area (each example is a real project, shown as its Project Code and Project Name):
- Nutrition:
  * Project Code: P1397, Project Name: Massakory Nutrition and Sexual and Reproductive Healthcare
  * Project Code: NG110, Project Name: Maiduguri Emergency Nutrition Care
  * Project Code: NG162, Project Name: Katsina Nutrition Care
- Refugees/IDPs:
  * Project Code: P1005, Project Name: Kutupalong Rohingya Refugee Secondary Healthcare
  * Project Code: P1188, Project Name: Central Mediterranean Search and Rescue
  * Project Code: P1642, Project Name: Gaza IDP Response
  * Project Code: TD180, Project Name: Adré Primary Healthcare for Sudanese Refugees
- Mental health:
  * Project Code: PI120, Project Name: Nablus Mental Health and SGBV Care
- Maternal health:
  * Project Code: AF183, Project Name: Khost Maternal and Neonatal Healthcare
  * Project Code: SS153, Project Name: Aweil State Maternity and Pediatrics Hospital
- Pediatrics:
  * Project Code: CF144, Project Name: Bria Pediatric Primary and Secondary Healthcare
- Climate impact:
  * Project Code: P1624, Project Name: Afghanistan Environmental Impact Project
  * Project Code: P1709, Project Name: Nigeria Environmental Impact Project
  * Project Code: P1798, Project Name: South Sudan Environmental Impact Project
  * Project Code: CF123, Project Name: Regional Climate, Environment and Health Roadmap - Green Initiative
  * Project Code: MG161, Project Name: Ikongo Planetary Health

23. **document_type** (REQUIRED): Classify what KIND of document this is, based on its OVERALL purpose (this describes the DOCUMENT, not the project):
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
    "project_code": "NG162",
    "project_name": "Katsina Nutrition Care",
    "mission_country": "Nigeria",
    "start_date": "2021-04-15",
    "end_date": "",
    "project_objective": "Large-scale malnutrition prevention and treatment, operating ITFCs and ATFCs and supporting malaria and epidemic response in Katsina State.",
    "is_new_project": "no",
    "is_emergency_project": "no",
    "is_closing_project": "no",
    "has_remote_management": "no",
    "remote_management_notes": null,
    "is_community_centered": "no",
    "context": "Armed Conflict",
    "event": "Population affected by endemics/epidemics",
    "population_type": "General Population",
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
            "quote_english": "We will maintain four out of 5 current ATFCs in the three (3) LGAs (1 in Katsina 2 in Jibia and 1 in Mashi). 1 ITFC in (Kofar Sauri) and the second ITFC Turai Yar'Adua Hospital during the peak.",
            "quote_original": "We will maintain four out of 5 current ATFCs in the three (3) LGAs (1 in Katsina 2 in Jibia and 1 in Mashi). 1 ITFC in (Kofar Sauri) and the second ITFC Turai Yar'Adua Hospital during the peak."
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
4. Return null for optional fields if not found
5. If the year ${year} does not appear in the document, OR no ${year}-specific activities are described, return an EMPTY activities_${year} array. Do NOT populate it with activities from other years.
6. Do NOT include operational/non-medical activities like capacity building, training, advocacy, stewardship, logistics, environmental sustainability, or supply chain management — only include MEDICAL SERVICE DELIVERY activities

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
