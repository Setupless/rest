import { describe, expect, it } from "bun:test";

import { RestError } from "./errors";
import { getPreferenceApplied, parsePreferences } from "./preferences";

function prefer(value?: string): Headers {
  return new Headers(value === undefined ? undefined : { Prefer: value });
}

describe("parsePreferences", () => {
  it("returns the immutable contract defaults when Prefer is absent", () => {
    const preferences = parsePreferences(prefer());

    expect(preferences).toEqual({
      handling: "lenient",
      return: "minimal",
      missing: "null",
    });
    expect(Object.isFrozen(preferences)).toBe(true);
  });

  it("parses every supported preference case-insensitively", () => {
    expect(
      parsePreferences(
        prefer(
          "HANDLING=STRICT, RETURN=REPRESENTATION, COUNT=EXACT, MISSING=DEFAULT, RESOLUTION=MERGE-DUPLICATES, MAX-AFFECTED=100",
        ),
      ),
    ).toEqual({
      handling: "strict",
      return: "representation",
      count: "exact",
      missing: "default",
      resolution: "merge-duplicates",
      maxAffected: 100,
    });
  });

  it("determines strict handling before validating earlier entries", () => {
    expect(() =>
      parsePreferences(prefer("future-option=yes, handling=strict")),
    ).toThrow(
      expect.objectContaining({
        code: "SLREST104",
        status: 400,
        details: 'Preference "future-option" is not supported.',
      }),
    );
  });

  it("ignores unknown, malformed, and invalid values under lenient handling", () => {
    expect(
      parsePreferences(
        prefer(
          "future-option=yes, malformed, return=verbose, count=estimated, max-affected=-1",
        ),
      ),
    ).toEqual({
      handling: "lenient",
      return: "minimal",
      missing: "null",
    });
  });

  it("uses the first occurrence of each name even when casing differs", () => {
    expect(
      parsePreferences(
        prefer(
          "return=representation, RETURN=minimal, missing=default, Missing=null, max-affected=7, MAX-AFFECTED=8",
        ),
      ),
    ).toEqual({
      handling: "lenient",
      return: "representation",
      missing: "default",
      maxAffected: 7,
    });
  });

  it("does not let a later duplicate rescue an invalid first handling value", () => {
    expect(
      parsePreferences(
        prefer("handling=careful, handling=strict, future-option=yes"),
      ),
    ).toEqual({
      handling: "lenient",
      return: "minimal",
      missing: "null",
    });
  });

  it.each(["0", "000", String(Number.MAX_SAFE_INTEGER)])(
    "accepts max-affected=%s",
    (value) => {
      expect(parsePreferences(prefer(`max-affected=${value}`))).toMatchObject({
        maxAffected: Number(value),
      });
    },
  );

  it.each(["-1", "+1", "1.0", "1e3", String(Number.MAX_SAFE_INTEGER + 1)])(
    "rejects max-affected=%s under strict handling",
    (value) => {
      expect(() =>
        parsePreferences(prefer(`handling=strict, max-affected=${value}`)),
      ).toThrow(
        expect.objectContaining({
          code: "SLREST104",
          details: 'Preference "max-affected" has an unsupported value.',
        }),
      );
    },
  );

  it.each([
    "handling=strict, return=secret-value",
    "handling=strict, malformed-secret",
    "handling=strict, future-option=secret-value",
    "handling=strict, count==secret-value",
  ])(
    "rejects strict invalid input without disclosing its value: %p",
    (value) => {
      try {
        parsePreferences(prefer(value));
        throw new Error("Expected preference parsing to fail");
      } catch (error) {
        expect(error).toBeInstanceOf(RestError);
        expect(error).toMatchObject({ code: "SLREST104" });
        expect((error as RestError).details).not.toContain("secret-value");
        expect((error as RestError).hint).not.toContain("secret-value");
      }
    },
  );
});

describe("getPreferenceApplied", () => {
  it("emits only requested applicable preferences in canonical order", () => {
    const preferences = parsePreferences(
      prefer(
        "max-affected=100, missing=default, count=exact, return=minimal, handling=lenient",
      ),
    );

    expect(getPreferenceApplied(preferences, "PATCH")).toBe(
      "handling=lenient, return=minimal, count=exact, max-affected=100",
    );
    expect(getPreferenceApplied(preferences, "POST")).toBe(
      "handling=lenient, return=minimal, count=exact, missing=default",
    );
    expect(getPreferenceApplied(preferences, "GET")).toBe(
      "handling=lenient, count=exact",
    );
  });

  it("includes explicitly requested defaults", () => {
    const preferences = parsePreferences(
      prefer("handling=lenient, return=minimal, missing=null"),
    );

    expect(getPreferenceApplied(preferences, "POST")).toBe(
      "handling=lenient, return=minimal, missing=null",
    );
  });

  it("ignores inapplicable preferences under lenient handling", () => {
    const preferences = parsePreferences(
      prefer("return=representation, count=exact, missing=default"),
    );

    expect(getPreferenceApplied(preferences, "root")).toBeNull();
    expect(getPreferenceApplied(preferences, "OPTIONS")).toBeNull();
    expect(getPreferenceApplied(preferences, "GET")).toBe("count=exact");
  });

  it("rejects the first inapplicable preference under strict handling", () => {
    const preferences = parsePreferences(
      prefer("handling=strict, missing=default, return=representation"),
    );

    expect(() => getPreferenceApplied(preferences, "GET")).toThrow(
      expect.objectContaining({
        code: "SLREST104",
        details: 'Preference "missing" does not apply to this request.',
      }),
    );
  });

  it.each([
    ["GET", "handling=strict, count=exact"],
    ["HEAD", "handling=strict, count=exact"],
    [
      "POST",
      "handling=strict, return=representation, count=exact, missing=default, resolution=ignore-duplicates",
    ],
    [
      "PATCH",
      "handling=strict, return=representation, count=exact, max-affected=5",
    ],
    [
      "DELETE",
      "handling=strict, return=representation, count=exact, max-affected=5",
    ],
    [
      "PUT",
      "handling=strict, return=representation, count=exact, missing=default",
    ],
  ] as const)("applies the contract subset for %s", (context, expected) => {
    const preferences = parsePreferences(
      prefer(
        context === "GET" || context === "HEAD"
          ? "handling=strict, count=exact"
          : context === "POST"
            ? "handling=strict, return=representation, count=exact, missing=default, resolution=ignore-duplicates"
            : context === "PUT"
              ? "handling=strict, return=representation, count=exact, missing=default"
              : "handling=strict, return=representation, count=exact, max-affected=5",
      ),
    );

    expect(getPreferenceApplied(preferences, context)).toBe(expected);
  });

  it("requires the original parsed object so explicit defaults stay traceable", () => {
    expect(() =>
      getPreferenceApplied(
        { handling: "lenient", return: "minimal", missing: "null" },
        "GET",
      ),
    ).toThrow("Preferences must be returned by parsePreferences");
  });
});
