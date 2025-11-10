import { Session } from 'next-auth';

// Types for localized content
export interface LocalizedContent {
  [locale: string]: {
    content: string;
    hash: string;
  };
}

// Types for terms and privacy policy
export interface TermsDocument {
  localized: LocalizedContent;
  version: string;
  required: boolean;
}

export interface TermsData {
  platformTerms: TermsDocument;
  privacyPolicy?: TermsDocument;
  [key: string]: TermsDocument | undefined; // Allow for future additional documents
}

export interface AcceptanceRecord {
  documentType: string;
  version: string;
  hash: string; // Hash of the accepted content
  locale: string; // The language version that was accepted
  acceptedAt: number; // timestamp
}

export interface UserAcceptance {
  userId: string;
  acceptedDocuments: AcceptanceRecord[];
}

// Local storage key
const TERMS_ACCEPTANCE_KEY = 'chatbot_terms_acceptance';

export const getUserAcceptance = (userId: string): UserAcceptance | null => {
  if (typeof window === 'undefined') return null;

  let storage: Storage;
  try {
    storage = window.localStorage;
  } catch {
    return null;
  }

  try {
    const allAcceptances = storage.getItem(TERMS_ACCEPTANCE_KEY);
    if (!allAcceptances) return null;

    const acceptances: UserAcceptance[] = JSON.parse(allAcceptances);
    return acceptances.find((a) => a.userId === userId) || null;
  } catch (error) {
    console.error(
      'Error retrieving terms acceptance from localStorage:',
      error,
    );
    return null;
  }
};

// Function to save user acceptance to localStorage
export const saveUserAcceptance = (
  userId: string,
  documentType: string,
  version: string,
  hash: string,
  locale: string = 'en',
): void => {
  if (typeof window === 'undefined') return; // Not in browser environment

  try {
    const allAcceptancesStr = localStorage.getItem(TERMS_ACCEPTANCE_KEY);
    const allAcceptances: UserAcceptance[] = allAcceptancesStr
      ? JSON.parse(allAcceptancesStr)
      : [];

    const userAcceptance = allAcceptances.find((a) => a.userId === userId);

    const newAcceptanceRecord: AcceptanceRecord = {
      documentType,
      version,
      hash,
      locale,
      acceptedAt: Date.now(),
    };

    if (userAcceptance) {
      // Update existing record or add new one
      const existingRecordIndex = userAcceptance.acceptedDocuments.findIndex(
        (doc) => doc.documentType === documentType,
      );

      if (existingRecordIndex >= 0) {
        userAcceptance.acceptedDocuments[existingRecordIndex] =
          newAcceptanceRecord;
      } else {
        userAcceptance.acceptedDocuments.push(newAcceptanceRecord);
      }
    } else {
      // Create new user acceptance record
      allAcceptances.push({
        userId,
        acceptedDocuments: [newAcceptanceRecord],
      });
    }

    localStorage.setItem(TERMS_ACCEPTANCE_KEY, JSON.stringify(allAcceptances));
  } catch (error) {
    console.error('Error saving terms acceptance to localStorage:', error);
  }
};

// Function to check if a user has accepted a specific document
export const hasUserAcceptedDocument = (
  userId: string,
  documentType: string,
  version: string,
  termsData: TermsData,
  locale: string = 'en',
): boolean => {
  const userAcceptance = getUserAcceptance(userId);
  if (!userAcceptance) return false;

  const acceptedDocument = userAcceptance.acceptedDocuments.find(
    (doc) => doc.documentType === documentType,
  );

  if (!acceptedDocument) return false;

  // Get the document from terms data
  const document = termsData[documentType];
  if (!document) return false;

  // Check if the version matches and the hash matches the localized content
  return (
    acceptedDocument.version === version &&
    document.localized[acceptedDocument.locale] &&
    acceptedDocument.hash === document.localized[acceptedDocument.locale].hash
  );
};

// Function to check if a user has accepted all required documents
export const hasUserAcceptedAllRequiredDocuments = (
  userId: string,
  termsData: TermsData,
  locale: string = 'en',
): boolean => {
  for (const [docType, document] of Object.entries(termsData)) {
    if (
      document &&
      document.required &&
      !hasUserAcceptedDocument(
        userId,
        docType,
        document.version,
        termsData,
        locale,
      )
    ) {
      return false;
    }
  }

  return true;
};

// Function to fetch the latest terms data from the API
export const fetchTermsData = async (): Promise<TermsData> => {
  try {
    const response = await fetch('/api/terms');
    if (!response.ok) {
      throw new Error('Failed to fetch terms data');
    }
    return await response.json();
  } catch (error) {
    console.error('Error fetching terms data:', error);
    throw error;
  }
};

// Function to check if the user needs to accept terms
export const checkUserTermsAcceptance = async (
  user: Session['user'],
  locale: string = 'en',
): Promise<boolean> => {
  if (!user) return false;

  try {
    // Use email (mail) as the primary identifier for terms acceptance
    // This is more stable and human-readable than the Azure AD GUID
    const userId = user?.mail || user?.id || '';
    if (!userId) return false;

    const termsData = await fetchTermsData();
    return hasUserAcceptedAllRequiredDocuments(userId, termsData, locale);
  } catch (error) {
    console.error('Error checking terms acceptance:', error);
    return false; // Default to requiring acceptance if there's an error
  }
};
