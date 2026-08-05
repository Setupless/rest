import { RestError } from "./errors";

export type RestMediaType =
  | { readonly kind: "json-array" }
  | { readonly kind: "json-object" }
  | { readonly kind: "openapi" };

type MediaKind = RestMediaType["kind"];

interface ParsedMediaRange {
  readonly type: string;
  readonly subtype: string;
  readonly parameters: ReadonlyMap<string, string>;
  readonly quality: number;
  readonly index: number;
}

interface MediaCandidate {
  readonly kind: MediaKind;
  readonly type: string;
  readonly subtype: string;
}

const TOKEN_PATTERN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const QUALITY_PATTERN = /^(?:0(?:\.\d{0,3})?|1(?:\.0{0,3})?)$/;
const UTF8_PATTERN = /^utf-8$/i;

const MEDIA_TYPES = {
  "json-array": Object.freeze({ kind: "json-array" }),
  "json-object": Object.freeze({ kind: "json-object" }),
  openapi: Object.freeze({ kind: "openapi" }),
} as const satisfies Record<MediaKind, RestMediaType>;

const RESOURCE_CANDIDATES: readonly MediaCandidate[] = Object.freeze([
  Object.freeze({
    kind: "json-array",
    type: "application",
    subtype: "json",
  }),
  Object.freeze({
    kind: "json-object",
    type: "application",
    subtype: "vnd.pgrst.object+json",
  }),
]);

const ROOT_CANDIDATES: readonly MediaCandidate[] = Object.freeze([
  Object.freeze({
    kind: "openapi",
    type: "application",
    subtype: "openapi+json",
  }),
  Object.freeze({
    // The root document is still an object; this kind selects application/json.
    kind: "json-array",
    type: "application",
    subtype: "json",
  }),
]);

/** Splits a structured header while preserving delimiters inside quoted values. */
function splitHeader(value: string, delimiter: string): string[] | null {
  const parts: string[] = [];
  let start = 0;
  let quoted = false;
  let escaped = false;

  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];

    if (escaped) {
      escaped = false;
      continue;
    }
    if (quoted && character === "\\") {
      escaped = true;
      continue;
    }
    if (character === '"') {
      quoted = !quoted;
      continue;
    }
    if (!quoted && character === delimiter) {
      parts.push(value.slice(start, index));
      start = index + 1;
    }
  }

  if (quoted || escaped) return null;
  parts.push(value.slice(start));
  return parts;
}

function parseParameterValue(value: string): string | null {
  if (TOKEN_PATTERN.test(value)) return value;
  if (!value.startsWith('"') || !value.endsWith('"') || value.length < 2) {
    return null;
  }

  let parsed = "";
  for (let index = 1; index < value.length - 1; index += 1) {
    const character = value[index];
    const code = character?.charCodeAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f || character === '"') return null;

    if (character === "\\") {
      index += 1;
      const escaped = value[index];
      if (escaped === undefined || escaped === "\r" || escaped === "\n") {
        return null;
      }
      parsed += escaped;
    } else {
      parsed += character;
    }
  }

  return parsed;
}

function parseMediaRange(
  value: string,
  index: number,
  accept: boolean,
): ParsedMediaRange | null {
  const segments = splitHeader(value, ";");
  if (segments === null || segments.length === 0) return null;

  const mediaType = segments[0]?.trim() ?? "";
  const slash = mediaType.indexOf("/");
  if (slash <= 0 || slash !== mediaType.lastIndexOf("/")) return null;

  const type = mediaType.slice(0, slash).toLowerCase();
  const subtype = mediaType.slice(slash + 1).toLowerCase();
  if (!TOKEN_PATTERN.test(type) || !TOKEN_PATTERN.test(subtype)) return null;
  if (!accept && (type.includes("*") || subtype.includes("*"))) return null;
  if (type === "*" && subtype !== "*") return null;

  const parameters = new Map<string, string>();
  const names = new Set<string>();
  let quality = 1;
  let qualitySeen = false;

  for (const rawSegment of segments.slice(1)) {
    const segment = rawSegment.trim();
    const equals = segment.indexOf("=");
    if (equals <= 0) return null;

    const name = segment.slice(0, equals).trim().toLowerCase();
    const rawParameterValue = segment.slice(equals + 1).trim();
    const parameterValue = parseParameterValue(rawParameterValue);
    if (
      !TOKEN_PATTERN.test(name) ||
      parameterValue === null ||
      names.has(name)
    ) {
      return null;
    }
    names.add(name);

    if (name === "q") {
      if (!accept || qualitySeen || !QUALITY_PATTERN.test(parameterValue)) {
        return null;
      }
      quality = Number(parameterValue);
      qualitySeen = true;
    } else if (!qualitySeen) {
      parameters.set(name, parameterValue);
    }
  }

  return { type, subtype, parameters, quality, index };
}

function unsupportedMediaType(
  header: "Accept" | "Content-Type",
  reason: "missing" | "malformed" | "unsupported",
  endpoint?: "resource" | "root",
): RestError<"SLREST105"> {
  const supported =
    header === "Accept"
      ? endpoint === "root"
        ? "Use application/openapi+json, application/json, or a matching wildcard."
        : "Use application/json, application/vnd.pgrst.object+json, or a matching wildcard."
      : "Use Content-Type: application/json with no parameter other than charset=utf-8.";
  const details =
    reason === "missing"
      ? `${header} is required for a request body.`
      : reason === "malformed"
        ? `${header} is malformed.`
        : `${header} does not include a supported media type.`;

  return new RestError("SLREST105", { details, hint: supported });
}

function parametersMatch(parameters: ReadonlyMap<string, string>): boolean {
  for (const [name, value] of parameters) {
    if (name !== "charset" || !UTF8_PATTERN.test(value)) return false;
  }
  return true;
}

function getSpecificity(
  range: ParsedMediaRange,
  candidate: MediaCandidate,
): number | null {
  if (range.type !== "*" && range.type !== candidate.type) return null;
  if (range.subtype !== "*" && range.subtype !== candidate.subtype) return null;
  if (!parametersMatch(range.parameters)) return null;
  if (range.type === "*") return 0;
  return range.subtype === "*" ? 1 : 2;
}

function getCandidateQuality(
  candidate: MediaCandidate,
  ranges: readonly ParsedMediaRange[],
): number {
  let selected:
    | {
        readonly specificity: number;
        readonly parameterCount: number;
        readonly range: ParsedMediaRange;
      }
    | undefined;

  for (const range of ranges) {
    const specificity = getSpecificity(range, candidate);
    if (specificity === null) continue;

    const parameterCount = range.parameters.size;
    if (
      selected === undefined ||
      specificity > selected.specificity ||
      (specificity === selected.specificity &&
        parameterCount > selected.parameterCount) ||
      (specificity === selected.specificity &&
        parameterCount === selected.parameterCount &&
        range.index < selected.range.index)
    ) {
      selected = { specificity, parameterCount, range };
    }
  }

  return selected?.range.quality ?? 0;
}

/** Negotiates the response representation for a resource or API root. */
export function negotiateResponseMediaType(
  headers: Headers,
  endpoint: "resource" | "root",
): RestMediaType {
  const accept = headers.get("Accept");
  const candidates =
    endpoint === "resource" ? RESOURCE_CANDIDATES : ROOT_CANDIDATES;
  if (accept === null) {
    const defaultKind = candidates[0]?.kind;
    if (defaultKind === undefined) throw new Error("Missing media candidate");
    return MEDIA_TYPES[defaultKind];
  }

  const parts = splitHeader(accept, ",");
  if (
    parts === null ||
    parts.length === 0 ||
    parts.some((part) => !part.trim())
  ) {
    throw unsupportedMediaType("Accept", "malformed", endpoint);
  }

  const ranges = parts.map((part, index) =>
    parseMediaRange(part.trim(), index, true),
  );
  if (ranges.some((range) => range === null)) {
    throw unsupportedMediaType("Accept", "malformed", endpoint);
  }

  let selected: MediaCandidate | undefined;
  let selectedQuality = 0;
  for (const candidate of candidates) {
    const quality = getCandidateQuality(
      candidate,
      ranges as readonly ParsedMediaRange[],
    );
    if (quality > selectedQuality) {
      selected = candidate;
      selectedQuality = quality;
    }
  }

  if (selected === undefined) {
    throw unsupportedMediaType("Accept", "unsupported", endpoint);
  }
  return MEDIA_TYPES[selected.kind];
}

/** Validates the only request-body media type supported by the 0.1 contract. */
export function validateRequestMediaType(headers: Headers): void {
  const contentType = headers.get("Content-Type");
  if (contentType === null || contentType.trim() === "") {
    throw unsupportedMediaType("Content-Type", "missing");
  }

  const values = splitHeader(contentType, ",");
  if (values === null || values.length !== 1) {
    throw unsupportedMediaType("Content-Type", "malformed");
  }

  const parsed = parseMediaRange(values[0]?.trim() ?? "", 0, false);
  if (parsed === null) {
    throw unsupportedMediaType("Content-Type", "malformed");
  }
  if (
    parsed.type !== "application" ||
    parsed.subtype !== "json" ||
    !parametersMatch(parsed.parameters)
  ) {
    throw unsupportedMediaType("Content-Type", "unsupported");
  }
}

/** Returns the exact success Content-Type for a negotiated representation. */
export function getResponseContentType(mediaType: RestMediaType): string {
  switch (mediaType.kind) {
    case "json-array":
      return "application/json; charset=utf-8";
    case "json-object":
      return "application/vnd.pgrst.object+json; charset=utf-8";
    case "openapi":
      return "application/openapi+json; charset=utf-8";
  }
}
