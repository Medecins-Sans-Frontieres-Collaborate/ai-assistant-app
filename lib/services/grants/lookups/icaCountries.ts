/**
 * ICA Country Code mapping.
 * Embedded from ica_country_codes.csv.
 */

const _ALIASES: Record<string, string> = {
  drc: 'Congo, Democratic Republic of the',
  'democratic republic of congo': 'Congo, Democratic Republic of the',
  'democratic republic of the congo': 'Congo, Democratic Republic of the',
  'dr congo': 'Congo, Democratic Republic of the',
  'congo-kinshasa': 'Congo, Democratic Republic of the',
  'south sudan': 'Sudan, South',
  car: 'Central African Republic',
  burma: 'Myanmar',
  'high seas': 'Search and Rescue Operations',
  swaziland: 'Eswatini',
};

interface IcaEntry {
  code: string;
  country: string;
}

const ICA_COUNTRY_MAPPING: Map<string, IcaEntry> = new Map();

// Embedded CSV data
const _DATA: [string, string][] = [
  ['P00101', 'Afghanistan'],
  ['P00201', 'Albania'],
  ['P00301', 'Algeria'],
  ['P00401', 'Angola'],
  ['P00501', 'Argentina'],
  ['P00601', 'Armenia'],
  ['P00701', 'Australia'],
  ['P00801', 'Austria'],
  ['P00901', 'Azerbaijan'],
  ['P01001', 'Bangladesh'],
  ['P01101', 'Belarus'],
  ['P01201', 'Belgium'],
  ['P01301', 'Belize'],
  ['P01401', 'Benin'],
  ['P01501', 'Bolivia'],
  ['P01601', 'Bosnia and Herzegovina'],
  ['P01701', 'Botswana'],
  ['P01801', 'Brazil'],
  ['P01901', 'Bulgaria'],
  ['P02001', 'Burkina Faso'],
  ['P02101', 'Burundi'],
  ['P02201', 'Cambodia'],
  ['P02301', 'Cameroon'],
  ['P02401', 'Canada'],
  ['P02501', 'Cape Verde'],
  ['P02601', 'Central African Republic'],
  ['P02701', 'Chad'],
  ['P02801', 'Chechnya / Ingushetia / Dagestan'],
  ['P02901', 'Chile'],
  ['P03001', 'China'],
  ['P03101', 'Colombia'],
  ['P03201', 'Congo, Democratic Republic of the'],
  ['P03301', 'Congo, Republic of the'],
  ['P03401', 'Costa Rica'],
  ['P03501', 'Croatia'],
  ['P03601', 'Cuba'],
  ['P03801', 'Czech Republic'],
  ['P07501', "Côte d'Ivoire"],
  ['P03901', 'Denmark'],
  ['P04001', 'Djibouti'],
  ['P04101', 'Dominica'],
  ['P04201', 'Dominican Republic'],
  ['P04301', 'East Timor'],
  ['P04401', 'Ecuador'],
  ['P04501', 'Egypt'],
  ['P04601', 'El Salvador'],
  ['P05001', 'Ethiopia'],
  ['P05101', 'Fiji'],
  ['P05201', 'Finland'],
  ['P05301', 'France'],
  ['P05401', 'Gabon'],
  ['P05501', 'Gambia, The'],
  ['P05601', 'Georgia'],
  ['P05701', 'Germany'],
  ['P05801', 'Ghana'],
  ['P05901', 'Greece'],
  ['P06001', 'Guatemala'],
  ['P06101', 'Guinea'],
  ['P06201', 'Guinea-Bissau'],
  ['P06301', 'Guyana'],
  ['P06401', 'Haiti'],
  ['P06501', 'Honduras'],
  ['P06601', 'Hungary'],
  ['P06701', 'Iceland'],
  ['P06801', 'India'],
  ['P06901', 'Indonesia'],
  ['P07001', 'Iran'],
  ['P07101', 'Iraq'],
  ['P07401', 'Italy'],
  ['P07601', 'Jamaica'],
  ['P07701', 'Japan'],
  ['P07801', 'Jordan'],
  ['P07901', 'Kazakhstan'],
  ['P08001', 'Kenya'],
  ['P08101', 'Korea, North'],
  ['P08201', 'Korea, South'],
  ['P08301', 'Kuwait'],
  ['P08401', 'Kyrgyzstan'],
  ['P08501', 'Laos'],
  ['P08601', 'Latvia'],
  ['P08701', 'Lebanon'],
  ['P08801', 'Lesotho'],
  ['P08901', 'Liberia'],
  ['P09001', 'Libya'],
  ['P09101', 'Lithuania'],
  ['P09201', 'Luxembourg'],
  ['P09301', 'Macedonia'],
  ['P09401', 'Madagascar'],
  ['P09501', 'Malawi'],
  ['P09701', 'Mali'],
  ['P09801', 'Malta'],
  ['P09901', 'Mauritania'],
  ['P10001', 'Mexico'],
  ['P10101', 'Moldova'],
  ['P10201', 'Mongolia'],
  ['P10301', 'Morocco'],
  ['P10401', 'Mozambique'],
  ['P10501', 'Myanmar'],
  ['P10601', 'Namibia'],
  ['P10651', 'Nauru'],
  ['P10701', 'Nepal'],
  ['P10801', 'Netherlands'],
  ['P10901', 'New Zealand'],
  ['P11001', 'Nicaragua'],
  ['P11101', 'Niger'],
  ['P11201', 'Nigeria'],
  ['P11301', 'Norway'],
  ['P11401', 'Pakistan'],
  ['P11501', 'Palestine'],
  ['P11601', 'Panama'],
  ['P11701', 'Papua New Guinea'],
  ['P12001', 'Philippines'],
  ['P12101', 'Poland'],
  ['P12201', 'Portugal'],
  ['P12301', 'Qatar'],
  ['P12401', 'Romania'],
  ['P12501', 'Russia (excl. Chechnya/Ingushetia)'],
  ['P12601', 'Rwanda'],
  ['P12701', 'Saudi Arabia'],
  ['P12801', 'Senegal'],
  ['P12901', 'Serbia and Montenegro'],
  ['P13001', 'Sierra Leone'],
  ['P13101', 'Singapore'],
  ['P13201', 'Slovakia'],
  ['P13301', 'Slovenia'],
  ['P13401', 'Somalia'],
  ['P13501', 'South Africa'],
  ['P13601', 'Spain'],
  ['P13701', 'Sri Lanka'],
  ['P13801', 'Sudan'],
  ['P13851', 'Sudan, South'],
  ['P13901', 'Suriname'],
  ['P14001', 'Eswatini'],
  ['P14301', 'Syria'],
  ['P14401', 'Taiwan'],
  ['P14501', 'Tajikistan'],
  ['P14601', 'Tanzania'],
  ['P14701', 'Thailand'],
  ['P14901', 'Togo'],
  ['P15001', 'Tunisia'],
  ['P15101', 'Turkey'],
  ['P15201', 'Turkmenistan'],
  ['P15301', 'Uganda'],
  ['P15401', 'Ukraine'],
  ['P15501', 'United Arab Emirates'],
  ['P15601', 'United Kingdom'],
  ['P15701', 'United States'],
  ['P15801', 'Uruguay'],
  ['P15901', 'Uzbekistan'],
  ['P16001', 'Venezuela'],
  ['P16101', 'Vietnam'],
  ['P16301', 'Yemen'],
  ['P09601', 'Malaysia'],
  ['P16801', 'Hong Kong'],
  ['P11901', 'Peru'],
  ['P8888', 'Transversal Activities'],
  ['P09951', 'Search and Rescue Operations'],
  ['L-E12000', 'HQ programme support'],
  ['L-E22000', 'Management, General and Administration'],
  ['L-E14000', 'Access Campaign'],
  ['L-E18000', 'Other Humanitarian Activities'],
  ['P04651', 'Emergency Fund'],
  ['P04801', 'Eritrea'],
  ['P16401', 'Zambia'],
  ['P16501', 'Zimbabwe'],
  ['P9999', 'Others'],
  ['P8888-COV', 'Transversal - COV'],
  ['P-TIC', 'TIC funding'],
  ['L-E16000', 'Awareness-Raising'],
  ['L-E20000', 'Private Fundraising'],
  ['P08011', 'Kiribati'],
  ['P03151', 'Comoros'],
];

// Initialize the mapping
for (const [code, country] of _DATA) {
  ICA_COUNTRY_MAPPING.set(country.toLowerCase(), { code, country });
}

// Add aliases
for (const [alias, canonical] of Object.entries(_ALIASES)) {
  const entry = ICA_COUNTRY_MAPPING.get(canonical.toLowerCase());
  if (entry) {
    ICA_COUNTRY_MAPPING.set(alias, entry);
  }
}

export function getIcaCountryInfo(missionCountry: string): [string, string] {
  if (!missionCountry) return ['', ''];

  const key = missionCountry.toLowerCase().trim();

  // Direct lookup
  const info = ICA_COUNTRY_MAPPING.get(key);
  if (info) return [info.country, info.code];

  // Partial matching
  for (const [k, entry] of ICA_COUNTRY_MAPPING) {
    if (k.includes(key) || key.includes(k)) {
      return [entry.country, entry.code];
    }
  }

  return ['', ''];
}
