/**
 * Country reference list and alias mapping.
 */

export const COUNTRY_ALIASES: Record<string, string> = {
  'democratic republic of congo': 'Democratic Republic of the Congo',
  'democratic republic of the congo': 'Democratic Republic of the Congo',
  drc: 'DRC',
  'dr congo': 'DRC',
  'congo-kinshasa': 'DRC',
  car: 'Central African Republic',
  'ivory coast': "Côte d'Ivoire",
  "cote d'ivoire": "Côte d'Ivoire",
  'south sudan': 'South Sudan',
  'burkina faso': 'Burkina Faso',
  palestine: 'Palestine',
  'west bank': 'Palestine',
  gaza: 'Palestine',
  'occupied palestinian territories': 'Palestine',
  'palestinian territories': 'Palestine',
  opt: 'Palestine',
  myanmar: 'Myanmar',
  burma: 'Myanmar',
  eswatini: 'Eswatini',
  swaziland: 'Eswatini',
  'timor-leste': 'Timor-Leste',
  'east timor': 'Timor-Leste',
  'guinea-bissau': 'Guinea-Bissau',
  'guinea bissau': 'Guinea-Bissau',
  'sierra leone': 'Sierra Leone',
  burkina: 'Burkina Faso',
  congo: 'Republic of the Congo',
  'congo-brazzaville': 'Republic of the Congo',
  'congo (brazzaville)': 'Republic of the Congo',
  'republic of congo': 'Republic of the Congo',
  png: 'Papua New Guinea',
  'papua new guinea': 'Papua New Guinea',
  bosnia: 'Bosnia and Herzegovina',
  'bosnia-herzegovina': 'Bosnia and Herzegovina',
  'bosnia and herzegovina': 'Bosnia and Herzegovina',
  'north macedonia': 'North Macedonia',
  macedonia: 'North Macedonia',
  laos: "Lao People's Democratic Republic",
  'lao pdr': "Lao People's Democratic Republic",
};

export const REFERENCE_COUNTRIES: Set<string> = new Set([
  'Afghanistan',
  'Albania',
  'Armenia',
  'Angola',
  'Bangladesh',
  'Belarus',
  'Belgium',
  'Benin',
  'Bolivia',
  'Bosnia and Herzegovina',
  'Brazil',
  'Burkina Faso',
  'Burundi',
  'Cambodia',
  'Cameroon',
  'Central African Republic',
  'Chad',
  'China',
  'Colombia',
  "Côte d'Ivoire",
  'Cuba',
  'Democratic Republic of the Congo',
  'Djibouti',
  'DRC',
  'Ecuador',
  'Egypt',
  'El Salvador',
  'Eritrea',
  'Eswatini',
  'Ethiopia',
  'France',
  'Greece',
  'Guatemala',
  'Guinea',
  'Guinea-Bissau',
  'Haiti',
  'Honduras',
  'India',
  'Indonesia',
  'Iran',
  'Iraq',
  'Italy',
  'Japan',
  'Jordan',
  'Kenya',
  'Kiribati',
  'Kyrgyzstan',
  "Lao People's Democratic Republic",
  'Lebanon',
  'Lesotho',
  'Liberia',
  'Libya',
  'Madagascar',
  'Malawi',
  'Malaysia',
  'Mali',
  'Mauritania',
  'Mexico',
  'Morocco',
  'Mozambique',
  'Myanmar',
  'Nauru',
  'Nepal',
  'Nicaragua',
  'Niger',
  'Nigeria',
  'North Macedonia',
  'Pakistan',
  'Palestine',
  'Panama',
  'Papua New Guinea',
  'Peru',
  'Philippines',
  'Republic of the Congo',
  'Romania',
  'Russia',
  'Rwanda',
  'Senegal',
  'Sierra Leone',
  'Somalia',
  'South Africa',
  'South Sudan',
  'Sri Lanka',
  'Sudan',
  'Syria',
  'Tajikistan',
  'Tanzania',
  'Thailand',
  'Timor-Leste',
  'Togo',
  'Tunisia',
  'Turkmenistan',
  'Uganda',
  'Ukraine',
  'Uzbekistan',
  'Venezuela',
  'Vietnam',
  'Yemen',
  'Zambia',
  'Zimbabwe',
]);

export function normalizeCountry(raw: string): string | null {
  if (!raw) return null;
  const stripped = raw.trim();

  // Exact match in reference set
  if (REFERENCE_COUNTRIES.has(stripped)) return stripped;

  // Alias lookup (case-insensitive)
  const canonical = COUNTRY_ALIASES[stripped.toLowerCase()];
  if (canonical) return canonical;

  // Case-insensitive match against reference set
  const lower = stripped.toLowerCase();
  for (const ref of REFERENCE_COUNTRIES) {
    if (ref.toLowerCase() === lower) return ref;
  }

  // Partial match
  for (const ref of REFERENCE_COUNTRIES) {
    if (
      lower.includes(ref.toLowerCase()) ||
      ref.toLowerCase().includes(lower)
    ) {
      return ref;
    }
  }

  return null;
}

export function mapToCountryReference(missionCountry: string): string {
  if (!missionCountry) return '';
  const mcLower = missionCountry.toLowerCase().trim();

  // Check aliases first
  if (mcLower in COUNTRY_ALIASES) return COUNTRY_ALIASES[mcLower];

  // Direct match in reference set
  for (const ref of REFERENCE_COUNTRIES) {
    if (ref.toLowerCase() === mcLower) return ref;
  }

  // Partial match
  for (const ref of REFERENCE_COUNTRIES) {
    if (
      mcLower.includes(ref.toLowerCase()) ||
      ref.toLowerCase().includes(mcLower)
    ) {
      return ref;
    }
  }

  return missionCountry; // Return as-is if no match
}
