/**
 * Activity normalization hierarchy and thematic flag derivation.
 *
 * Contains:
 * - TERM_HIERARCHY: 14-category hierarchy mapping trigger terms to canonical names
 * - MEDICAL_ACTIVITIES_VOCAB: complete vocabulary for LLM extraction prompts
 * - THEMATIC_KEYWORDS: keywords for deriving the 10 thematic boolean columns
 * - determineThematicFlags(): deterministic flag derivation from activities
 */

export const TERM_HIERARCHY: Record<string, string[]> = {
  'Maternal Health': [
    'ANC',
    'Vaginal Deliveries',
    'C-sections',
    'Contraceptive',
    'TOP',
    'Post AB Care',
    'PNC',
    'Obstetric Services',
    'Obstetric',
    'Kangaroo Mother Care',
    'Family Planning',
    'Midwifery',
    'Midwifery Training',
    'Respectful Maternal Care',
    'Maternity Services',
    'Safe Abortion Care',
    'BEmONC',
    'CEmONC',
    'SONUC',
    'Preeclampsia Management',
  ],
  Neonatology: [
    'Neonatal Intensive Care',
    'Neonatology Support',
    'Neonatal Care',
    'NICU',
    'Newborn Care',
  ],
  NTDs: [
    'NTDs',
    'NTD',
    'Kala Azar',
    'CL & MCL',
    'Snake Bites',
    'HAT',
    'Chagas',
  ],
  Vaccination: [
    'Routine Vacc',
    'Prev Vacc Doses',
    'Measles vaccination',
    'Measles treatment',
    'Meningitis vaccination',
    'Meningitis treatment',
    'Yellow Fever vaccination',
    'Yellow Fever management',
    'Cholera vaccination',
    'Cholera Management',
    'Hep B Vacc NB',
    'Routine Immunization',
    'Immunization',
    'Routine Vaccination',
    'Vaccination Campaign',
    'Mass Vaccination',
    'EPI',
  ],
  'WatSan and NFI': [
    'GFD',
    'NFI',
    'Sanitation',
    'Water Distribution',
    'WASH',
    'Hygiene Kit Distribution',
    'Hygiene Kits',
    'Hygiene Kit',
    'Water Trucking',
    'Water Supply',
    'Water Point',
    'Water Points',
    'Borehole Rehabilitation',
    'Borehole',
    'Boreholes',
    'Latrine',
    'Latrines',
    'Latrine Construction',
    'Animal Trough',
    'Animal Troughs',
  ],
  SGBV: [
    'Sexual Violence',
    'Intentional physical violence',
    'Victims of Torture',
    'SGBV Services',
    'SGBV Care',
    'SGBV Medical',
  ],
  HIV: [
    'HIV',
    'ART',
    'PMTCT Mothers',
    'PMTCT Babies',
    'PMTCT Services',
    'Pediatric HIV Care',
    'Advanced HIV Care',
    'HIV Testing',
    'ART Initiation',
    'HIV and TB',
  ],
  NCDs: [
    'NCDs',
    'NCD',
    'HBP',
    'Diabetes',
    'NCD Care',
    'NCD Treatment',
    'NCD Mentorship',
    'Non-Communicable',
    'Hypertension',
  ],
  'Outpatient Care': ['OPD'],
  'Inpatient Care': ['IPD'],
  Surgery: ['Surgery', 'Surgical Interventions', 'Surgical Services'],
  TB: [
    'TB',
    'TB treatment',
    'Tuberculosis',
    'TB Screening',
    'DRTB',
    'TB Preventive Treatment',
  ],
  'Mental Health': ['MH', 'Mental Health'],
  SRH: ['SRH', 'Reproductive Health', 'SRH Services', 'Adolescent SRH'],
  Nutrition: [
    'ITFC',
    'ATFC',
    'MAM',
    'SAM',
    'Food Distribution',
    'SFC',
    'Targeted Nutritional Support',
    'Malnutrition',
    'Malnutrition screening',
    'Nutritional screening',
    'Nutrition screening',
    'Undernutrition',
    'Acute malnutrition',
    'Moderate malnutrition',
    'Severe malnutrition',
  ],
  Malaria: ['Malaria'],
  'Community Health': [
    'Community Engagement',
    'Community Mobilization',
    'Community Outreach',
    'Community Health Workers',
  ],
};

export const MEDICAL_ACTIVITIES_VOCAB: string[] = [
  // Canonical terms from hierarchy
  'Maternal Health',
  'Neonatology',
  'NTDs',
  'Vaccination',
  'WatSan and NFI',
  'SGBV',
  'HIV',
  'NCDs',
  'Outpatient Care',
  'Inpatient Care',
  'Surgery',
  'TB',
  'Mental Health',
  'SRH',
  'Nutrition',
  'Malaria',
  'Community Health',
  // Additional common terms (not in hierarchy - include as-is)
  'Primary Healthcare',
  'Secondary Healthcare',
  'Emergency Care',
  'Trauma Care',
  'Pediatric Care',
  'Laboratory Services',
  'Referral Services',
  'Blood Transfusion',
  'Health Promotion',
  'Community Engagement',
  'Emergency Response',
  'Epidemic Response',
  'Hepatitis C',
  'Palliative Care',
];

export const THEMATIC_KEYWORDS: Record<string, string[]> = {
  'Impact of Climate Change': [
    'climate',
    'climate change',
    'environmental health',
    'drought',
    'flood',
    'natural disaster',
  ],
  Nutrition: [
    'nutrition',
    'malnutrition',
    'itfc',
    'atfc',
    'sam',
    'mam',
    'feeding',
    'undernutrition',
    'nutritional',
    'food distribution',
    'sfc',
    'therapeutic feeding',
    'supplementary feeding',
  ],
  'Refugees and IDPs': [
    'refugee',
    'refugees',
    'idp',
    'displaced',
    'displacement',
    'migration',
    'migrant',
    'asylum',
    'returnee',
  ],
  'Emergency Relief Fund': [
    'emergency relief',
    'emergency response',
    'erf',
    'rapid response',
    'crisis response',
  ],
  'Mental Health': [
    'mental health',
    'mhpss',
    'psychosocial',
    'psychological',
    'psychiatr',
    'counselling',
    'counseling',
    'mh',
  ],
  'Maternal Health': [
    'maternal',
    'obstetric',
    'antenatal',
    'prenatal',
    'postnatal',
    'neonatal',
    'delivery',
    'midwife',
    'midwifery',
    'c-section',
    'bemonc',
    'cemonc',
    'anc',
    'pnc',
    'pmtct',
  ],
  Pediatrics: [
    'pediatric',
    'paediatric',
    'children',
    'child health',
    'neonatal',
    'newborn',
    'neonatology',
  ],
  'Community/Patient-Centered': [
    'community health',
    'community-based',
    'patient-centered',
    'community centered',
    'community engagement',
    'health promotion',
    'community health worker',
    'chw',
  ],
  'Armed Conflict': [
    'armed conflict',
    'war',
    'combat',
    'military',
    'victims of armed conflict',
    'conflict-affected',
  ],
  'Sensitive Context for Screening': [],
};

export function normalizeActivity(raw: string): string {
  const stripped = raw.trim();
  const lower = stripped.toLowerCase();

  // Pass 0: exact match against canonical category names
  for (const canonical of Object.keys(TERM_HIERARCHY)) {
    if (canonical.toLowerCase() === lower) {
      return canonical;
    }
  }

  // Pass 1: exact match against trigger terms
  for (const [canonical, triggers] of Object.entries(TERM_HIERARCHY)) {
    for (const trigger of triggers) {
      if (trigger.toLowerCase() === lower) {
        return canonical;
      }
    }
  }

  // Pass 2: activity contains a trigger (trigger is a substring of activity)
  for (const [canonical, triggers] of Object.entries(TERM_HIERARCHY)) {
    for (const trigger of triggers) {
      const tl = trigger.toLowerCase();
      if (tl.length >= 4 && lower.includes(tl)) {
        return canonical;
      }
    }
  }

  // Pass 3: trigger contains the activity (activity is a substring of trigger)
  if (lower.length >= 4) {
    for (const [canonical, triggers] of Object.entries(TERM_HIERARCHY)) {
      for (const trigger of triggers) {
        const tl = trigger.toLowerCase();
        if (tl.length >= 4 && tl.includes(lower)) {
          return canonical;
        }
      }
    }
  }

  return stripped;
}

export function determineThematicFlags(
  activities: string[],
): Record<string, boolean> {
  const combined = activities.map((a) => a.toLowerCase()).join(' ');
  const flags: Record<string, boolean> = {};

  for (const [theme, keywords] of Object.entries(THEMATIC_KEYWORDS)) {
    if (theme === 'Sensitive Context for Screening') {
      flags[theme] = false;
      continue;
    }
    flags[theme] = keywords.some((kw) => combined.includes(kw));
  }

  return flags;
}

interface ActivityDict {
  activity?: string;
  section?: string;
  quote_english?: string;
  quote_original?: string;
  [key: string]: unknown;
}

export function formatActivitiesList(activities: ActivityDict[]): string {
  if (!activities || activities.length === 0) return '';
  const labels: string[] = [];
  for (const act of activities) {
    const label =
      typeof act === 'object' && act !== null
        ? act.activity || ''
        : String(act);
    const normalized = normalizeActivity(label);
    if (normalized && !labels.includes(normalized)) {
      labels.push(normalized);
    }
  }
  return labels.join(', ');
}

export function formatEvidenceSummary(activities: ActivityDict[]): string {
  if (!activities || activities.length === 0) return '';
  const parts: string[] = [];
  for (const act of activities) {
    if (typeof act !== 'object' || act === null) continue;
    const label = act.activity || 'Unknown';
    const section = act.section || '';
    const quoteEn = act.quote_english || '';
    const quoteOrig = act.quote_original || '';

    let entry = `- ${label}`;
    if (section) entry += `\n  Section: ${section}`;
    if (quoteEn) entry += `\n  English: ${quoteEn}`;
    if (quoteOrig && quoteOrig !== quoteEn)
      entry += `\n  Supporting Text: ${quoteOrig}`;
    parts.push(entry);
  }
  return parts.join('\n\n');
}
