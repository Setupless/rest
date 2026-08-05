import { RestError } from "./errors";

export type RestPreferenceName =
  | "handling"
  | "return"
  | "count"
  | "missing"
  | "resolution"
  | "max-affected";

export interface RestPreferences {
  readonly handling: "lenient" | "strict";
  readonly return: "minimal" | "headers-only" | "representation";
  readonly count?: "exact";
  readonly missing: "null" | "default";
  readonly resolution?: "merge-duplicates" | "ignore-duplicates";
  readonly maxAffected?: number;
}

export type RestPreferenceContext =
  | "root"
  | "health"
  | "OPTIONS"
  | "GET"
  | "HEAD"
  | "POST"
  | "PATCH"
  | "DELETE"
  | "PUT";

interface RawPreference {
  readonly index: number;
  readonly name: string | null;
  readonly value: string | null;
  readonly malformed: boolean;
}

interface PreferenceMetadata {
  readonly requested: ReadonlyMap<RestPreferenceName, string | number>;
  readonly order: readonly RestPreferenceName[];
}

const TOKEN_PATTERN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const DECIMAL_PATTERN = /^\d+$/;
const preferenceMetadata = new WeakMap<RestPreferences, PreferenceMetadata>();

const CANONICAL_ORDER: readonly RestPreferenceName[] = Object.freeze([
  "handling",
  "return",
  "count",
  "missing",
  "resolution",
  "max-affected",
]);

const SUPPORTED_VALUES: Readonly<Record<RestPreferenceName, string>> =
  Object.freeze({
    handling: "lenient or strict",
    return: "minimal, headers-only, or representation",
    count: "exact",
    missing: "null or default",
    resolution: "merge-duplicates or ignore-duplicates",
    "max-affected": "a non-negative decimal safe integer",
  });

function isPreferenceName(value: string): value is RestPreferenceName {
  return Object.hasOwn(SUPPORTED_VALUES, value);
}

function parseRawPreference(value: string, index: number): RawPreference {
  const trimmed = value.trim();
  const equals = trimmed.indexOf("=");
  const candidateName = (equals < 0 ? trimmed : trimmed.slice(0, equals))
    .trim()
    .toLowerCase();
  const name = TOKEN_PATTERN.test(candidateName) ? candidateName : null;

  if (
    !trimmed ||
    equals <= 0 ||
    equals !== trimmed.lastIndexOf("=") ||
    name === null
  ) {
    return { index, name, value: null, malformed: true };
  }

  const candidateValue = trimmed
    .slice(equals + 1)
    .trim()
    .toLowerCase();
  if (!TOKEN_PATTERN.test(candidateValue)) {
    return { index, name, value: null, malformed: true };
  }

  return { index, name, value: candidateValue, malformed: false };
}

function invalidPreference(
  name: string | null,
  reason: "malformed" | "unsupported" | "value" | "inapplicable",
): RestError<"SLREST104"> {
  if (reason === "malformed" || name === null) {
    return new RestError("SLREST104", {
      details: "Prefer contains a malformed preference.",
      hint: "Use comma-separated name=value preferences or handling=lenient.",
    });
  }

  if (reason === "unsupported") {
    return new RestError("SLREST104", {
      details: `Preference ${JSON.stringify(name)} is not supported.`,
      hint: "Remove it or use handling=lenient.",
    });
  }

  if (reason === "inapplicable") {
    return new RestError("SLREST104", {
      details: `Preference ${JSON.stringify(name)} does not apply to this request.`,
      hint: "Remove it or use handling=lenient.",
    });
  }

  const supported = isPreferenceName(name)
    ? SUPPORTED_VALUES[name]
    : "a supported value";
  return new RestError("SLREST104", {
    details: `Preference ${JSON.stringify(name)} has an unsupported value.`,
    hint: `Use ${supported}, or use handling=lenient.`,
  });
}

function parseSupportedValue(
  name: RestPreferenceName,
  value: string,
): string | number | null {
  switch (name) {
    case "handling":
      return value === "lenient" || value === "strict" ? value : null;
    case "return":
      return value === "minimal" ||
        value === "headers-only" ||
        value === "representation"
        ? value
        : null;
    case "count":
      return value === "exact" ? value : null;
    case "missing":
      return value === "null" || value === "default" ? value : null;
    case "resolution":
      return value === "merge-duplicates" || value === "ignore-duplicates"
        ? value
        : null;
    case "max-affected": {
      if (!DECIMAL_PATTERN.test(value)) return null;
      const parsed = Number(value);
      return Number.isSafeInteger(parsed) ? parsed : null;
    }
  }
}

function getFirstPreferences(
  preferences: readonly RawPreference[],
): ReadonlyMap<string, RawPreference> {
  const first = new Map<string, RawPreference>();
  for (const preference of preferences) {
    if (preference.name !== null && !first.has(preference.name)) {
      first.set(preference.name, preference);
    }
  }
  return first;
}

/** Parses Prefer independently of route-specific applicability. */
export function parsePreferences(headers: Headers): RestPreferences {
  const header = headers.get("Prefer");
  const rawPreferences =
    header === null
      ? []
      : header
          .split(",")
          .map((value, index) => parseRawPreference(value, index));
  const firstPreferences = getFirstPreferences(rawPreferences);
  const rawHandling = firstPreferences.get("handling");
  const handling =
    rawHandling?.malformed === false &&
    (rawHandling.value === "lenient" || rawHandling.value === "strict")
      ? rawHandling.value
      : "lenient";
  const requested = new Map<RestPreferenceName, string | number>();
  const order: RestPreferenceName[] = [];

  for (const rawPreference of rawPreferences) {
    if (
      rawPreference.name !== null &&
      firstPreferences.get(rawPreference.name)?.index !== rawPreference.index
    ) {
      continue;
    }

    if (rawPreference.malformed || rawPreference.name === null) {
      if (handling === "strict") {
        throw invalidPreference(rawPreference.name, "malformed");
      }
      continue;
    }
    if (!isPreferenceName(rawPreference.name)) {
      if (handling === "strict") {
        throw invalidPreference(rawPreference.name, "unsupported");
      }
      continue;
    }

    const parsed = parseSupportedValue(
      rawPreference.name,
      rawPreference.value ?? "",
    );
    if (parsed === null) {
      if (handling === "strict") {
        throw invalidPreference(rawPreference.name, "value");
      }
      continue;
    }

    requested.set(rawPreference.name, parsed);
    order.push(rawPreference.name);
  }

  const preferences: RestPreferences = Object.freeze({
    handling,
    return: (requested.get("return") ?? "minimal") as RestPreferences["return"],
    ...(requested.get("count") === "exact" ? { count: "exact" as const } : {}),
    missing: (requested.get("missing") ?? "null") as RestPreferences["missing"],
    ...(requested.has("resolution")
      ? {
          resolution: requested.get(
            "resolution",
          ) as RestPreferences["resolution"],
        }
      : {}),
    ...(requested.has("max-affected")
      ? { maxAffected: requested.get("max-affected") as number }
      : {}),
  });

  preferenceMetadata.set(preferences, {
    requested,
    order: Object.freeze(order),
  });
  return preferences;
}

function isApplicable(
  name: RestPreferenceName,
  context: RestPreferenceContext,
): boolean {
  if (name === "handling") return true;
  if (name === "count") {
    return !["root", "health", "OPTIONS"].includes(context);
  }
  if (name === "return") {
    return ["POST", "PATCH", "DELETE", "PUT"].includes(context);
  }
  if (name === "missing") return context === "POST" || context === "PUT";
  if (name === "resolution") return context === "POST";
  if (name === "max-affected") {
    return context === "PATCH" || context === "DELETE";
  }

  const unhandled: never = name;
  throw new TypeError(`Unhandled preference: ${String(unhandled)}`);
}

/**
 * Validates method applicability and returns canonical Preference-Applied text.
 * Null means no requested preference applies to this successful request.
 */
export function getPreferenceApplied(
  preferences: RestPreferences,
  context: RestPreferenceContext,
): string | null {
  const metadata = preferenceMetadata.get(preferences);
  if (metadata === undefined) {
    throw new TypeError("Preferences must be returned by parsePreferences");
  }

  if (preferences.handling === "strict") {
    const inapplicable = metadata.order.find(
      (name) => !isApplicable(name, context),
    );
    if (inapplicable !== undefined) {
      throw invalidPreference(inapplicable, "inapplicable");
    }
  }

  const applied: string[] = [];
  for (const name of CANONICAL_ORDER) {
    const value = metadata.requested.get(name);
    if (value !== undefined && isApplicable(name, context)) {
      applied.push(`${name}=${value}`);
    }
  }
  return applied.length === 0 ? null : applied.join(", ");
}
