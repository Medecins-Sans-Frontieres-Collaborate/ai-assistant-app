import { Session } from 'next-auth';

const EUVariableMap: Record<string, string> = {
  AZURE_BLOB_STORAGE_NAME: 'AZURE_BLOB_STORAGE_NAME_EU',
};

interface EnvVariableOptions {
  name: string;
  throwErrorOnFail?: boolean;
  defaultValue?: string;
  user?: Session['user'] | undefined;
}

/**
 * Fetches the value of a specific environment variable. If the environment variable is not set, it either returns a default value or throws an error based on the flag throwErrorOnFail
 *
 * @param {string | EnvVariableOptions} nameOrOptions - The name of the environment variable or an object containing all options.
 * @param {boolean} [throwErrorOnFail=true] - Flag that decides whether to throw an error or not when the environment variable is not set. Default is true.
 * @param {string} [defaultValue=''] - The default value to return when the environment variable is not set and throwErrorOnFail is false. Default is an empty string.
 * @param {Session["user"] | undefined} [user] - The user session object.
 *
 * @returns {string} - The value of the environment variable if it is set. Throws an error or returns the defaultValue based on the throwErrorOnFail flag if the environment variable is not set.
 *
 * @throws {Error} - Throws an error if the environment variable is not set and the flag throwErrorOnFail is set to true.
 */
export function getEnvVariable(
  nameOrOptions: string | EnvVariableOptions,
  throwErrorOnFail: boolean = true,
  defaultValue: string = '',
  user?: Session['user'] | undefined,
): string {
  let name: string;
  let options: EnvVariableOptions;

  if (typeof nameOrOptions === 'string') {
    name = nameOrOptions;
    options = { name, throwErrorOnFail, defaultValue, user };
  } else {
    options = nameOrOptions;
    name = options.name;
    throwErrorOnFail = options.throwErrorOnFail ?? true;
    defaultValue = options.defaultValue ?? '';
    user = options.user;
  }

  // Region is the single source of truth for data-plane routing. It is resolved
  // once at auth time (office/email lookup, plus any active override) and stored
  // on `session.user.region`, so blob storage and the Foundry endpoint route
  // consistently and both honor the override. Fall back to the legacy email
  // heuristic only for sessions issued before `region` existed.
  let euUser: boolean = true;
  if (user?.region) {
    euUser = user.region === 'EU';
  } else if (user?.mail) {
    const domain = user.mail.toLowerCase().split('@')[1];
    // newyork.msf.org (or a subdomain) ⇒ US; everyone else ⇒ EU default.
    euUser = !(
      domain &&
      (domain === 'newyork.msf.org' || domain.endsWith('.newyork.msf.org'))
    );
  }

  let value: string | undefined;
  if (!euUser || !EUVariableMap[name]) {
    value = process.env[name];
  } else {
    // Try EU-specific variable first, fallback to standard variable
    value = process.env[EUVariableMap[name]] || process.env[name];
  }

  if (!value && throwErrorOnFail) {
    console.error(
      `[ENV ERROR] Variable ${name} not found. euUser=${euUser}, user.mail=${user?.mail}, EUVariableMap[${name}]=${EUVariableMap[name]}, process.env[${name}]=${!!process.env[name]}, process.env[${EUVariableMap[name]}]=${!!process.env[EUVariableMap[name]]}`,
    );
    throw new Error(`Environment variable ${name} not set`);
  } else if (!value) {
    return defaultValue;
  }
  return value;
}

/**
 * Checks if the current device is a mobile device. The function identifies a mobile device based on the `navigator.userAgent` property.
 *
 * @returns {boolean} - Returns true if the current device is a mobile device. Returns false otherwise. If the function is called in a server-side rendering scenario (where `window` is undefined), the function returns false.
 */
export function isMobile(): boolean {
  if (typeof window === 'undefined') return false; // For SSR
  return /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(
    navigator.userAgent,
  );
}
