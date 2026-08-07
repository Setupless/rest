import { RestError } from "./errors";

function bodyTooLarge(maxBodyBytes: number): RestError<"SLREST108"> {
  return new RestError("SLREST108", {
    details: `The request body exceeds the configured limit of ${maxBodyBytes} bytes.`,
  });
}

function declaredBodyLength(request: Request): number | undefined {
  const value = request.headers.get("Content-Length");
  if (value === null || !/^\d+$/u.test(value)) return undefined;
  const length = Number(value);
  return Number.isSafeInteger(length) ? length : Number.POSITIVE_INFINITY;
}

/**
 * Buffers a request body up to the configured byte ceiling before any parser
 * sees it, including bodies whose size is not declared up front.
 */
export async function limitRequestBody(
  request: Request,
  maxBodyBytes: number,
): Promise<Request> {
  if (!Number.isSafeInteger(maxBodyBytes) || maxBodyBytes < 1) {
    throw new TypeError(
      "Maximum request body bytes must be a positive integer",
    );
  }

  if ((declaredBodyLength(request) ?? 0) > maxBodyBytes) {
    throw bodyTooLarge(maxBodyBytes);
  }
  if (request.body === null) return request;

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBodyBytes) {
        try {
          await reader.cancel();
        } catch {
          // The bounded public failure takes precedence over stream cleanup.
        }
        throw bodyTooLarge(maxBodyBytes);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return new Request(request, { body });
}
