/**
 * Purpose code mapping for MSF grant extraction pipeline.
 */

export const COUNTRY_TO_PURPOSE_CODE: Record<string, string> = {
  afghanistan: '2AF - Afghanistan',
  albania: '2AL - Albania',
  armenia: '2AM - Armenia',
  angola: '2AO - Angola',
  bosnia: '2BA - Bosnia',
  'bosnia and herzegovina': '2BA - Bosnia',
  bangladesh: '2BD - Bangladesh',
  'burkina faso': '2BF - Burkina Faso',
  burundi: '2BI - Burundi',
  bolivia: '2BO - Bolivia',
  brazil: '2BR - Brazil',
  cambodia: '2C1 - Cambodia',
  chad: '2C2 - Chad',
  'democratic republic of congo': '2CD - Dem. Rep. of Congo',
  'democratic republic of the congo': '2CD - Dem. Rep. of Congo',
  drc: '2CD - Dem. Rep. of Congo',
  'dr congo': '2CD - Dem. Rep. of Congo',
  'congo-kinshasa': '2CD - Dem. Rep. of Congo',
  'central african republic': '2CF - Central African Republic',
  car: '2CF - Central African Republic',
  congo: '2CG - Congo(-Brazzaville)',
  'congo-brazzaville': '2CG - Congo(-Brazzaville)',
  'republic of congo': '2CG - Congo(-Brazzaville)',
  'ivory coast': '2CI - Ivory Coast',
  "cote d'ivoire": '2CI - Ivory Coast',
  "côte d'ivoire": '2CI - Ivory Coast',
  cameroon: '2CM - Cameroon',
  china: '2CN - China',
  colombia: '2CO - Colombia',
  cuba: '2CU - Cuba',
  djibouti: '2DJ - Djibouti',
  'timor-leste': '2E1 - Timor-Leste',
  'east timor': '2E1 - Timor-Leste',
  'el salvador': '2E2 - El Salvador',
  ecuador: '2EC - Ecuador',
  egypt: '2EG - Egypt',
  eritrea: '2ER - Eritrea',
  ethiopia: '2ET - Ethiopia',
  france: '2FR - France',
  guinea: '2GN - Guinea',
  greece: '2GR - Greece',
  guatemala: '2GT - Guatemala',
  honduras: '2HN - Honduras',
  haiti: '2HT - Haiti',
  indonesia: '2ID - Indonesia',
  india: '2IN - India',
  iraq: '2IQ - Iraq and Iraqi Population',
  iran: '2IR - Iran',
  jordan: '2JO - Jordan',
  kenya: '2KE - Kenya',
  kyrgyzstan: '2KG - Kyrgyzstan',
  laos: '2LA - Laos',
  lebanon: '2LB - Lebanon',
  'sri lanka': '2LK - Sri Lanka',
  liberia: '2LR - Liberia',
  lesotho: '2LS - Lesotho',
  libya: '2LY - Libya',
  madagascar: '2MG - Madagascar',
  mali: '2ML - Mali',
  myanmar: '2MM - Myanmar',
  burma: '2MM - Myanmar',
  mauritania: '2MR - Mauritania',
  malawi: '2MW - Malawi',
  mexico: '2MX - Mexico',
  mozambique: '2MZ - Mozambique',
  nigeria: '2NG - Nigeria',
  nicaragua: '2NI - Nicaragua',
  niger: '2NR - Niger',
  peru: '2PE - Peru',
  'papua new guinea': '2PG - Papua New Guinea',
  philippines: '2PH - Philippines',
  pakistan: '2PK - Pakistan',
  palestine: '2PS - Palestinian Territories',
  'palestinian territories': '2PS - Palestinian Territories',
  'west bank': '2PS - Palestinian Territories',
  gaza: '2PS - Palestinian Territories',
  romania: '2RO - Romania',
  russia: '2RU - Russia',
  rwanda: '2RW - Rwanda',
  'south africa': '2SA - South Africa',
  sudan: '2SD - Sudan and Sudanese Population',
  senegal: '2SE - Senegal',
  'sierra leone': '2SL - Sierra Leone',
  somalia: '2SO - Somalia and Somali population',
  syria: '2SY - Syria and Syrian population',
  eswatini: '2SZ - Eswatini (fmr. Swaziland)',
  swaziland: '2SZ - Eswatini (fmr. Swaziland)',
  tajikistan: '2TA - Tajikistan',
  thailand: '2TH - Thailand',
  ukraine: '2UA - Ukraine',
  uganda: '2UG - Uganda',
  uzbekistan: '2UZ - Uzbekistan',
  venezuela: '2VE - Venezuela',
  vietnam: '2VN - Vietnam',
  yemen: '2YE - Yemen',
  zambia: '2ZM - Zambia',
  zimbabwe: '2ZW - Zimbabwe',
  chechnya: '3CH - Chechnya',
  darfur: '3DA - Darfur, Sudan',
  'north kivu': '3NK - North Kivu-DRC',
  'south sudan': '3SS - South Sudan',
};

export const ACTIVITY_TO_PURPOSE_CODE: Record<string, string> = {
  hiv: 'D01 - HIV/AIDS',
  aids: 'D01 - HIV/AIDS',
  art: 'D01 - HIV/AIDS',
  antiretroviral: 'D01 - HIV/AIDS',
  pmtct: 'D01 - HIV/AIDS',
  'kala azar': 'D03 - Kala Azar',
  leishmaniasis: 'D03 - Kala Azar',
  'visceral leishmaniasis': 'D03 - Kala Azar',
  malaria: 'D04 - Malaria Programs',
  'sleeping sickness': 'D07 - Sleeping Sickness',
  trypanosomiasis: 'D07 - Sleeping Sickness',
  hat: 'D07 - Sleeping Sickness',
  'neglected diseases': 'D09 - Neglected Diseases',
  ntd: 'D09 - Neglected Diseases',
  ntds: 'D09 - Neglected Diseases',
  chagas: 'D09 - Neglected Diseases',
  'snake bite': 'D09 - Neglected Diseases',
  tuberculosis: 'D13 - Tuberculosis',
  tb: 'D13 - Tuberculosis',
  measles: 'D14 - Measles',
  'drug-resistant tb': 'D15 - Drug-Resistant Tuberculosis',
  'mdr-tb': 'D15 - Drug-Resistant Tuberculosis',
  'xdr-tb': 'D15 - Drug-Resistant Tuberculosis',
  meningitis: 'D16 - Meningitis',
  cancer: 'D17 - Cancer',
  oncology: 'D17 - Cancer',
  ncd: 'D18 - Non-Communicable Diseases',
  ncds: 'D18 - Non-Communicable Diseases',
  'non-communicable': 'D18 - Non-Communicable Diseases',
  diabetes: 'D18 - Non-Communicable Diseases',
  hypertension: 'D18 - Non-Communicable Diseases',
  epilepsy: 'D18 - Non-Communicable Diseases',
  cholera: 'S01 - Cholera',
  'medical supplies': 'S04 - Medical Relief & Supplies',
  'medical relief': 'S04 - Medical Relief & Supplies',
  vaccination: 'S05 - Vaccinations',
  vaccine: 'S05 - Vaccinations',
  immunization: 'S05 - Vaccinations',
  pediatric: 'T02 - Childrens Health Issues',
  paediatric: 'T02 - Childrens Health Issues',
  children: 'T02 - Childrens Health Issues',
  'child health': 'T02 - Childrens Health Issues',
  neonatal: 'T02 - Childrens Health Issues',
  newborn: 'T02 - Childrens Health Issues',
  nutrition: 'T03 - Nutrition Programs',
  malnutrition: 'T03 - Nutrition Programs',
  itfc: 'T03 - Nutrition Programs',
  atfc: 'T03 - Nutrition Programs',
  sam: 'T03 - Nutrition Programs',
  mam: 'T03 - Nutrition Programs',
  feeding: 'T03 - Nutrition Programs',
  epidemiological: 'T05 - Epidemiological Research',
  research: 'T05 - Epidemiological Research',
  surgery: 'T06 - Surgery',
  surgical: 'T06 - Surgery',
  refugee: 'T07 - Refugees and Internal Displacement',
  refugees: 'T07 - Refugees and Internal Displacement',
  idp: 'T07 - Refugees and Internal Displacement',
  displaced: 'T07 - Refugees and Internal Displacement',
  displacement: 'T07 - Refugees and Internal Displacement',
  migration: 'T07 - Refugees and Internal Displacement',
  migrant: 'T07 - Refugees and Internal Displacement',
  'access campaign': 'T09 - Access to Essential Medicines Campaign',
  'essential medicines': 'T09 - Access to Essential Medicines Campaign',
  dndi: 'T11 - DNDi-Drugs for Neglected Diseases',
  maternal: "T17 - Women's Health",
  'maternal health': "T17 - Women's Health",
  "women's health": "T17 - Women's Health",
  'reproductive health': "T17 - Women's Health",
  srh: "T17 - Women's Health",
  anc: "T17 - Women's Health",
  delivery: "T17 - Women's Health",
  obstetric: "T17 - Women's Health",
  bemonc: "T17 - Women's Health",
  cemonc: "T17 - Women's Health",
  maternity: "T17 - Women's Health",
  'sexual violence': 'T18 - Sexual and Gender Based Violence',
  sgbv: 'T18 - Sexual and Gender Based Violence',
  'gender-based violence': 'T18 - Sexual and Gender Based Violence',
  gbv: 'T18 - Sexual and Gender Based Violence',
  rape: 'T18 - Sexual and Gender Based Violence',
  'mental health': 'T22 - Mental Health Programs',
  psychological: 'T22 - Mental Health Programs',
  psychosocial: 'T22 - Mental Health Programs',
  mhpss: 'T22 - Mental Health Programs',
  ebola: 'T24 - Ebola Outbreak Response',
  advocacy: 'T25 - Advocacy',
  telemedicine: 'T28 - Telemedicine',
  telehealth: 'T28 - Telemedicine',
  abortion: 'T29 - Safe Abortion & Contraception Training /Capacity Building',
  contraception:
    'T29 - Safe Abortion & Contraception Training /Capacity Building',
  'family planning':
    'T29 - Safe Abortion & Contraception Training /Capacity Building',
  water: 'T30 - Water and sanitation',
  sanitation: 'T30 - Water and sanitation',
  wash: 'T30 - Water and sanitation',
  watsan: 'T30 - Water and sanitation',
  hygiene: 'T30 - Water and sanitation',
  climate: 'T32 - Health & Humanitarian Impacts of Climate Change',
  'antimicrobial resistance': 'T34 - Antimicrobial Resistance',
  amr: 'T34 - Antimicrobial Resistance',
  'lake chad': 'E74 - Borno & Lake Chad Region Crisis',
  borno: 'E74 - Borno & Lake Chad Region Crisis',
  covid: 'E78 - COVID-19 Impact & Outbreak Response',
  'covid-19': 'E78 - COVID-19 Impact & Outbreak Response',
  coronavirus: 'E78 - COVID-19 Impact & Outbreak Response',
  earthquake: 'E79 - 2023 Turkiye\u2013Syria Earthquakes Response',
  'gaza emergency': 'E81 - Regional Fund - Gaza Emergency',
  'emergency relief': 'ERF - Emergency Relief Fund',
};

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function getPurposeCodes(country: string, projectName: string): string {
  const codes = new Set<string>();
  const countryLower = country ? country.toLowerCase().trim() : '';
  const nameLower = projectName ? projectName.toLowerCase().trim() : '';

  // Country-based code
  if (countryLower) {
    if (countryLower in COUNTRY_TO_PURPOSE_CODE) {
      codes.add(COUNTRY_TO_PURPOSE_CODE[countryLower]);
    } else {
      for (const [key, code] of Object.entries(COUNTRY_TO_PURPOSE_CODE)) {
        if (key.includes(countryLower) || countryLower.includes(key)) {
          codes.add(code);
          break;
        }
      }
    }
  }

  // Activity/keyword-based codes from project name
  if (nameLower) {
    for (const [keyword, code] of Object.entries(ACTIVITY_TO_PURPOSE_CODE)) {
      const pattern = new RegExp('\\b' + escapeRegExp(keyword) + '\\b', 'i');
      if (pattern.test(nameLower)) {
        codes.add(code);
      }
    }
  }

  const sorted = Array.from(codes).sort((a, b) => {
    const prefixA = a.split(' - ')[0] || a;
    const prefixB = b.split(' - ')[0] || b;
    const orderA = prefixA.match(/^[23]/)
      ? 0
      : prefixA.startsWith('D')
        ? 1
        : prefixA.startsWith('T')
          ? 2
          : 3;
    const orderB = prefixB.match(/^[23]/)
      ? 0
      : prefixB.startsWith('D')
        ? 1
        : prefixB.startsWith('T')
          ? 2
          : 3;
    if (orderA !== orderB) return orderA - orderB;
    return prefixA.localeCompare(prefixB);
  });

  return sorted.join(', ');
}

export function lookupCode(name: string): string | null {
  return ACTIVITY_TO_PURPOSE_CODE[name.toLowerCase().trim()] || null;
}
