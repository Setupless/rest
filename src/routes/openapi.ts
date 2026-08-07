import { RestError } from "../http/errors";
import {
  getResponseContentType,
  negotiateResponseMediaType,
} from "../http/media-type";
import { getPreferenceApplied, parsePreferences } from "../http/preferences";
import { resolveRequestId } from "../http/request-id";

const ALLOW = "GET, HEAD, OPTIONS";

/** Creates a root handler around one immutable startup OpenAPI document. */
export function createOpenApiRequestHandler(
  document: Readonly<Record<string, unknown>>,
): (request: Request, requestId?: string) => Response {
  const body = JSON.stringify(document);

  return (
    request: Request,
    requestId = resolveRequestId(request),
  ): Response => {
    if (request.method === "OPTIONS") {
      const preferences = parsePreferences(request.headers);
      getPreferenceApplied(preferences, "OPTIONS");
      return new Response(null, {
        status: 204,
        headers: { Allow: ALLOW, "X-Request-Id": requestId },
      });
    }
    if (request.method !== "GET" && request.method !== "HEAD") {
      throw new RestError("SLREST204", {
        details: `Method ${request.method} is not available for the API root.`,
        headers: { Allow: ALLOW },
      });
    }

    const preferences = parsePreferences(request.headers);
    const preferenceApplied = getPreferenceApplied(preferences, "root");
    const mediaType = negotiateResponseMediaType(request.headers, "root");
    const headers = new Headers({
      "Content-Type": getResponseContentType(mediaType),
      "X-Request-Id": requestId,
    });
    if (preferenceApplied !== null) {
      headers.set("Preference-Applied", preferenceApplied);
    }

    return new Response(request.method === "HEAD" ? null : body, {
      status: 200,
      headers,
    });
  };
}
