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
     b) Expand ALL acronyms (e.g., "PHC" -> "Primary Health Care")
     c) REQUIRED format: "[Single Location or Region Name] [Main Medical Activity/Focus]"
        - CRITICAL: The location MUST be a SINGLE name — either one city/town OR one region/province
        - NEVER list multiple locations separated by commas, "and", or slashes
        - If the project operates in multiple specific locations, you MUST use a single broader regional or national-level name instead
          e.g., Fada, Matiacoali, Kompienga, Kantchari → use "Eastern Region" (NOT "Fada, Matiacoali, Kompienga and Kantchari")
          e.g., N'Djamena, Moyen-Chari, Salamat, Ouaddaï → use "Chad Multi-Region" or the most prominent single location
          e.g., Oudalan, Seno, Yagha, Soum → use "Sahel Region"
        - GOOD examples: "Eastern Region Primary and Secondary Healthcare", "Sahel Region Emergency Healthcare", "Kongoussi Displaced Populations Healthcare"
        - BAD examples: "N'Djamena, Moyen-Chari, Salamat and Ouaddaï Emergency Healthcare", "Fada and Matiacoali Healthcare" — NEVER list multiple locations
     d) Never use all-caps
     e) Always write "healthcare" as ONE WORD (not "health care")
     f) Common acronyms to expand: SRH=Sexual and Reproductive Health, TB=Tuberculosis, HIV=HIV/AIDS Care, MH=Mental Health, PHC=Primary Health Care`;
}

function getProjectObjectiveInstructions(year: number): string {
  return `
   - Write ONE sentence describing the project's main purpose, target population, and location
   - Do NOT start with "Provide" — instead begin directly with the healthcare type or purpose
     e.g., "Emergency and maternal secondary healthcare for conflict-affected populations in Eastern Region"
   - CRITICAL: Do NOT include the country name anywhere in the objective — not at the beginning, not at the end, not in any form. The country is already captured in a separate column. For example, write "Primary healthcare for displaced populations in Diffa Region" NOT "Primary healthcare for displaced populations in Diffa Region, Niger"
   - Do NOT list individual medical activities — they are captured in the Key Terms/Activities column
     Instead, use 1-2 high-level descriptors: "primary healthcare", "secondary healthcare", "emergency response", "mental health and psychosocial support"
   - Expand ALL acronyms — e.g., write "Dafra Medical Center with Surgical Unit" not "CMA de Dafra"
   - Use American English spelling and phrases — e.g., "operating room" not "operating theatre", "pediatric" not "paediatric", "organization" not "organisation"
   - For closure/handover plans:
     * If the project is fully closing, being handed over to another OC, or undergoing a significant partial handover/reorientation IN ${year}, you MUST mention this in the objective — e.g., "; full handover to OCB planned for March ${year}" or "; Kumbotso and Rijiyar Lemo facilities to be handed over to state authorities in ${year}"
     * If a handover agreement is verbal and not officially confirmed, state that clearly — e.g., "; verbal agreement for handover to MoH, not yet officially confirmed"
     * Do NOT include standard exit strategies, sustainability planning, or closure plans for years beyond ${year}
   - Keep it concise — one sentence maximum, with handover details appended after a semicolon if applicable`;
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

  let codeExample: string;
  let codeHint: string;

  if (ocName === 'OCA') {
    codeExample = 'P1412';
    codeHint = 'Format is P + 3-4 digit number (e.g., P1412, P987)';
  } else if (ocName === 'OCBA') {
    codeExample = 'ESAF183';
    codeHint = `Format is ES + 2-letter country + 2-4 digit number (e.g., ESAF183, ESCD507). Prefix "${codePrefix}" is required.`;
  } else if (ocName === 'OCP') {
    codeExample = 'AF110';
    codeHint =
      'Format is 2-letter country code + 2-4 digit number (e.g., AF110, CD507). One document may contain MULTIPLE projects.';
  } else if (ocName === 'WaCA') {
    codeExample = 'BF201';
    codeHint =
      'Format is 2-3 letter code + optional W + 2-3 digit number (e.g., BF201, MLW12)';
  } else {
    codeExample = 'AF101';
    codeHint =
      'Format is 2-letter country code + 2-4 digit number (e.g., AF101, BD112)';
  }

  let multiProjectSection = '';
  if (ocCfg.multi_project) {
    multiProjectSection = `
## MULTI-PROJECT DOCUMENTS
This OC (OCP) submits country-level documents that describe MULTIPLE projects.
You MUST extract ALL projects found in the document, not just the first one.
Return a JSON object with a "projects" key containing an array of project objects.
Each project object follows the same schema described below.

Example multi-project response:
\`\`\`json
{
    "projects": [
        {"project_code": "AF110", "project_name": "...", ...},
        {"project_code": "AF120", "project_name": "...", ...}
    ]
}
\`\`\`
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

## CRITICAL REQUIREMENT - ${year} ACTIVITIES ONLY
- ONLY extract medical activities that are EXPLICITLY planned, described, or referenced for the year ${year}
- The document MUST contain the literal string "${year}" (the four-digit year) for you to extract any activities. If the year ${year} does not appear ANYWHERE in the document text, you MUST return an empty activities_${year} array — no exceptions.
- DO NOT assume that ongoing projects or projects without an end date automatically have activities in ${year}. A project described for ${prevYear} does NOT automatically extend to ${year} unless the document explicitly says so.
- Look for sections like "${year} objectives", "In ${year}", "Plan for ${year}", "Activities for ${year}"
- Only if the document explicitly states that specific activities will continue into or are planned for ${year}, include those activities
- EACH individual activity you extract MUST have a supporting quote that explicitly mentions or is directly connected to the year ${year}. Do NOT extract an activity just because ${year} appears elsewhere in the document — the quote for THAT specific activity must relate to ${year}.
- If unsure whether an activity is for ${year}, check for temporal indicators — the year ${year} must be explicitly referenced in connection with the activity

${multiProjectSection}

## FIELDS TO EXTRACT:

1. **project_code** (REQUIRED): The unique project identifier
   - ${codeHint}
   - Regex pattern: ${codeRegex}
   - Look for: "Project Code", "Code du projet", "Project Number"

2. **project_name** (REQUIRED): The full title of the project
   - Look for: "Title of the Project", "Project Name", "Titre du projet"
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
   - Extract EVERY distinct medical service category the project delivers — be thorough
   - Use the vocabulary terms above whenever possible — e.g., if the project provides neonatal care, list "Neonatology"; if it has a lab, list "Laboratory Services"; if it responds to outbreaks, list "Epidemic Response"; if it mentions HIV/ART, list "HIV"; if it mentions TB, list "TB"; if it mentions blood transfusion, list "Blood Transfusion"; if it refers patients, list "Referral Services"; if it mentions community health workers or outreach, list "Community Health"
   - GOOD: "Maternal Health", "Neonatology", "Vaccination", "Mental Health", "Nutrition", "Surgery", "SRH", "Laboratory Services", "Epidemic Response", "Primary Healthcare", "HIV", "TB", "Blood Transfusion", "Referral Services", "Community Health", "SGBV", "Palliative Care"
   - BAD: "Kangaroo Mother Care" (technique within Maternal Health — use "Maternal Health"), "Antimicrobial Stewardship" (operational protocol), "Capacity Building" (operational), "Biomedical Sustainability" (operational)
   - Include ALL distinct medical service lines but NOT operational/administrative details
   - Aim for 5-12 activities per project — if a project provides many medical services, list them all

7. **evidence**: For EACH activity, provide citation evidence with TWO quotes:
   - **section**: The section name where the activity was found
   - **quote_english**: MUST be in English - if document is in French/Spanish/other, TRANSLATE this quote to English
   - **quote_original**: The EXACT text copied from the document in its ORIGINAL language (for Ctrl+F search in PDF)
   - Example for French document:
     * quote_english: "Strengthen mental health care activities with focus on identification and referral of cases at IDP sites."
     * quote_original: "Renforcement des activités de soins de santé mentale avec focus sur l'identification et orientation des cas au niveau des sites IDPs."

8. **project_active**: Is the project active as of December 31, ${year}? (yes/no)
   - "yes" if project continues through or beyond December 31, ${year}
   - "no" if project ends before December 31, ${year} or is closed/closing before that date

9. **project_objective** (REQUIRED): One sentence about the project's main objective/focus and location
${objectiveInstructions}

10. **is_new_project**: Is this a new project? (yes/no)
    - "yes" if the project is described as new, recently launched, starting in ${prevYear}/${year}, or in its first year
    - Look for: "new project", "newly established", "launched in", "starting", "first year", "pilot"
    - "no" if the project has been running for multiple years or is established

11. **is_emergency_project**: Is this an emergency response project? (yes/no)
    - "yes" ONLY if the project was LAUNCHED AS an emergency response, crisis response, or disaster response — i.e., the entire project exists to respond to an acute emergency
    - "no" for ongoing/established medical projects that include emergency response CAPACITY or preparedness as one component
    - "no" for general hospitals or healthcare projects in conflict zones — operating in a conflict area does NOT make a project an "emergency project"
    - A referral hospital that maintains emergency preparedness and responds to outbreaks = "no" (it's a general healthcare project)
    - A project deployed specifically to respond to a cholera outbreak or earthquake = "yes"

12. **is_closing_project**: Is this project closing or being handed over?
${closingInstructions}

13. **has_remote_management**: Does this project involve remote management? (yes/no)
${remoteInstructions}

14. **is_community_centered**: Is this project primarily community-based or patient-centered in its delivery model? (yes/no)
    - "yes" if the project's core approach involves delivering care through community structures
    - Look for: community health workers (CHWs), mobile clinics going to communities, village-level interventions, home-based care, decentralized care delivery, community outreach as primary strategy
    - "no" if the project is primarily facility-based (hospital, clinic, health center) even if it includes some community activities like health promotion
    - A hospital project with health promotion activities is NOT community-centered
    - The key question: WHERE is care primarily delivered - in facilities or in communities?

15. **context**: ONE of: "Armed Conflict", "Internal Instability", "Post-Conflict", "Stable"

16. **event**: ONE of: "Population affected by endemics/epidemics", "Population affected by natural disaster", "Population affected by social violence and healthcare exclusion", "Victims of armed conflict"

17. **population_type**: ONE of: "Displaced", "General Population", "Mixed Displaced/General", "Victims of Natural Disasters"

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
- An emergency response project specifically deployed for a crisis = focuses_on_emergency_response: "yes"
- A general hospital that maintains emergency response capacity = focuses_on_emergency_response: "no"

18. **focuses_on_nutrition** 19. **focuses_on_refugees_idps** 20. **focuses_on_mental_health**
21. **focuses_on_maternal_health** 22. **focuses_on_pediatrics** 23. **focuses_on_climate_impact**
24. **focuses_on_emergency_response**

## OUTPUT FORMAT (JSON):

\`\`\`json
{
    "project_code": "AM120",
    "project_name": "Hepatitis C Simplified Service Delivery in Armenia",
    "mission_country": "Armenia",
    "start_date": "2022-09-01",
    "end_date": "${year}-12-31",
    "project_active": "yes",
    "project_objective": "Simplified hepatitis C testing and treatment for vulnerable populations including prisoners.",
    "is_new_project": "no",
    "is_emergency_project": "no",
    "is_closing_project": "no",
    "has_remote_management": "no",
    "remote_management_notes": null,
    "is_community_centered": "no",
    "context": "Stable",
    "event": "Population affected by endemics/epidemics",
    "population_type": "General Population",
    "focuses_on_nutrition": "no",
    "focuses_on_refugees_idps": "no",
    "focuses_on_mental_health": "no",
    "focuses_on_maternal_health": "no",
    "focuses_on_pediatrics": "no",
    "focuses_on_climate_impact": "no",
    "focuses_on_emergency_response": "no",
    "activities_${year}": [
        {
            "activity": "Hepatitis C Test and Treat",
            "section": "Expected Results",
            "quote_english": "Hep.C Test and Treat approach is implemented for micro elimination in prison.",
            "quote_original": "Hep.C Test and Treat approach is implemented for micro elimination in prison."
        },
        {
            "activity": "Maternal Health",
            "section": "Proposition ${year}",
            "quote_english": "Consolidation of activities with a focus on reproductive health.",
            "quote_original": "Consolidation des activites avec un accent sur la sante de la reproduction."
        }
    ]
}
\`\`\`

Example for ongoing project with no end date:
\`\`\`json
{
    "project_code": "${codeExample}",
    "project_name": "Hebron",
    "mission_country": "Palestine",
    "start_date": "2001-01-01",
    "end_date": "ongoing",
    "project_active": "yes",
    "activities_${year}": [...]
}
\`\`\`

## IMPORTANT RULES:
1. Each activity MUST have a supporting quote that can be found via Ctrl+F
2. Quotes should be 1-2 sentences max, directly mentioning the activity
3. If document is in French, translate activity names to English but keep quotes in original language
4. Return null for optional fields if not found
5. If the year ${year} does not appear in the document, OR no ${year}-specific activities are described, return an EMPTY activities_${year} array. Do NOT populate it with activities from other years.
6. For end_date: Use "ongoing" if no end date is found/mentioned and project is active in ${year}
7. Do NOT include operational/non-medical activities like capacity building, training, advocacy, stewardship, logistics, environmental sustainability, or supply chain management — only include MEDICAL SERVICE DELIVERY activities

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
