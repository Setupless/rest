const coverageFile = process.argv[2] ?? "coverage/lcov.info";
const criticalThreshold = 0.9;

interface CoverageMetrics {
  readonly functionsFound: number;
  readonly functionsHit: number;
  readonly linesFound: number;
  readonly linesHit: number;
}

interface CoverageRecord extends CoverageMetrics {
  readonly source: string;
}

interface CoverageGroup {
  readonly name: string;
  readonly files: readonly string[];
  readonly threshold: number;
}

const zeroMetrics = (): CoverageMetrics => ({
  functionsFound: 0,
  functionsHit: 0,
  linesFound: 0,
  linesHit: 0,
});

const metricValue = (record: string, prefix: string): number => {
  const line = record
    .split("\n")
    .find((candidate) => candidate.startsWith(prefix));
  const value = Number(line?.slice(prefix.length));

  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Invalid or missing ${prefix.slice(0, -1)} metric`);
  }

  return value;
};

const parseCoverage = (report: string): ReadonlyMap<string, CoverageRecord> => {
  const records = new Map<string, CoverageRecord>();

  for (const rawRecord of report.split("end_of_record")) {
    const sourceLine = rawRecord
      .split("\n")
      .find((line) => line.startsWith("SF:"));
    if (sourceLine === undefined) {
      continue;
    }

    const source = sourceLine.slice(3).replaceAll("\\", "/");
    records.set(source, {
      source,
      functionsFound: metricValue(rawRecord, "FNF:"),
      functionsHit: metricValue(rawRecord, "FNH:"),
      linesFound: metricValue(rawRecord, "LF:"),
      linesHit: metricValue(rawRecord, "LH:"),
    });
  }

  return records;
};

const sourceFiles = (
  pattern: string,
  excluded: ReadonlySet<string> = new Set(),
) =>
  [...new Bun.Glob(pattern).scanSync({ cwd: ".", onlyFiles: true })]
    .map((file) => file.replaceAll("\\", "/"))
    .filter((file) => !file.endsWith(".test.ts") && !file.endsWith(".d.ts"))
    .filter((file) => !excluded.has(file))
    .sort();

const groups: readonly CoverageGroup[] = [
  {
    name: "overall",
    files: sourceFiles(
      "src/**/*.ts",
      new Set(["src/auth/types.ts", "src/index.ts"]),
    ),
    threshold: 0.85,
  },
  {
    name: "query",
    files: sourceFiles("src/query/**/*.ts"),
    threshold: criticalThreshold,
  },
  {
    name: "auth",
    files: sourceFiles("src/auth/**/*.ts", new Set(["src/auth/types.ts"])),
    threshold: criticalThreshold,
  },
  {
    name: "schema",
    files: ["src/database/relationships.ts", "src/database/schema.ts"],
    threshold: criticalThreshold,
  },
  {
    name: "execution",
    files: sourceFiles("src/execution/**/*.ts"),
    threshold: criticalThreshold,
  },
];

const addMetrics = (
  total: CoverageMetrics,
  current: CoverageMetrics,
): CoverageMetrics => ({
  functionsFound: total.functionsFound + current.functionsFound,
  functionsHit: total.functionsHit + current.functionsHit,
  linesFound: total.linesFound + current.linesFound,
  linesHit: total.linesHit + current.linesHit,
});

const percentage = (hit: number, found: number) =>
  found === 0 ? 0 : (hit / found) * 100;

const formatMetric = (hit: number, found: number) =>
  `${percentage(hit, found).toFixed(2)}% (${hit}/${found})`;

const report = await Bun.file(coverageFile).text();
const records = parseCoverage(report);
let failed = false;

for (const group of groups) {
  const missing = group.files.filter((file) => !records.has(file));
  if (missing.length > 0) {
    console.error(
      `${group.name}: coverage report is missing ${missing.join(", ")}`,
    );
    failed = true;
    continue;
  }

  const metrics = group.files.reduce(
    (total, file) => addMetrics(total, records.get(file) ?? zeroMetrics()),
    zeroMetrics(),
  );
  const lines = percentage(metrics.linesHit, metrics.linesFound);
  const functions = percentage(metrics.functionsHit, metrics.functionsFound);

  console.log(
    `${group.name}: lines ${formatMetric(metrics.linesHit, metrics.linesFound)}, functions ${formatMetric(metrics.functionsHit, metrics.functionsFound)}`,
  );

  if (lines < group.threshold * 100 || functions < group.threshold * 100) {
    console.error(
      `${group.name}: line and function coverage must each be at least ${group.threshold * 100}%`,
    );
    failed = true;
  }
}

if (failed) {
  process.exit(1);
}
