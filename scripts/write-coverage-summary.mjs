import { appendFile, readFile } from "node:fs/promises";

const coverageReportPath = "coverage/coverage-summary.json";
const jobSummaryPath = process.env.GITHUB_STEP_SUMMARY;

if (!jobSummaryPath) {
  throw new Error("GITHUB_STEP_SUMMARY is not set.");
}

const coverageReport = JSON.parse(await readFile(coverageReportPath, "utf8"));
const metrics = [
  ["Statements", "statements"],
  ["Branches", "branches"],
  ["Functions", "functions"],
  ["Lines", "lines"],
];
const rows = metrics.map(([label, key]) => {
  const metric = coverageReport.total[key];
  return `| ${label} | ${metric.covered} | ${metric.total} | ${metric.pct}% |`;
});
const markdown = [
  "## Coverage report",
  "",
  "| Metric | Covered | Total | Coverage |",
  "| --- | ---: | ---: | ---: |",
  ...rows,
  "",
].join("\n");

await appendFile(jobSummaryPath, markdown, "utf8");
