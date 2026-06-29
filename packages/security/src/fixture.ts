import type { RawSecurityFinding, SnykResult } from "./index";

const rawDep = {
  ok: false,
  packageManager: "npm",
  dependencyCount: 142,
  projectFolder: "/repo",
  packageName: "demo-app",
  vulnerabilities: [
    {
      id: "SNYK-JS-LODASH-1018907",
      packageName: "lodash",
      version: "4.17.20",
      severity: "high",
      title: "Prototype Pollution",
      name: "lodash",
      from: ["demo-app@1.0.0", "lodash@4.17.20"],
      fixInfo: { isFixable: true, version: "4.17.21" },
      isUpgradable: true,
      cvssScore: 7.4,
    },
    {
      id: "SNYK-JS-DRIZZLEORM-7010000",
      packageName: "drizzle-orm",
      version: "0.28.0",
      severity: "medium",
      title: "SQL Injection via unsanitized raw query input",
      name: "drizzle-orm",
      from: ["demo-app@1.0.0", "drizzle-orm@0.28.0"],
      fixInfo: { isFixable: true, version: "0.29.0" },
      isUpgradable: true,
      cvssScore: 5.3,
    },
  ],
};

const rawSast = {
  ok: false,
  projectName: "demo-app",
  runs: [
    {
      tool: {
        driver: {
          name: "SnykCode",
          rules: [
            {
              id: "SNYK-JS-REGEXDOS",
              title: "Regex DoS",
              shortDescription: { text: "Regular expression denial of service" },
              defaultConfiguration: { level: "warning" },
              properties: { severity: "medium", tags: ["Security"] },
            },
            {
              id: "SNYK-JS-HARDCODEDPASSWORD",
              title: "Hardcoded Password",
              shortDescription: { text: "Hardcoded password in source" },
              defaultConfiguration: { level: "error" },
              properties: { severity: "high", tags: ["Security"] },
            },
          ],
        },
      },
      results: [
        {
          ruleId: "SNYK-JS-REGEXDOS",
          level: "warning",
          severity: "medium",
          message: { text: "Potential regular expression denial of service (ReDoS)" },
          locations: [
            {
              physicalLocation: {
                artifactLocation: { uri: "src/utils/parse.js" },
                region: { startLine: 42 },
              },
            },
          ],
        },
        {
          ruleId: "SNYK-JS-HARDCODEDPASSWORD",
          level: "error",
          severity: "high",
          message: { text: "Hardcoded password detected in database connection string" },
          locations: [
            {
              physicalLocation: {
                artifactLocation: { uri: "src/db/users.js" },
                region: { startLine: 17 },
              },
            },
          ],
        },
      ],
    },
  ],
};

const depFindings: RawSecurityFinding[] = [
  {
    kind: "dep",
    severity: "high",
    package: "lodash",
    vulnVersion: "4.17.20",
    fixedVersion: "4.17.21",
    message: "Prototype Pollution",
    rule: "SNYK-JS-LODASH-1018907",
  },
  {
    kind: "dep",
    severity: "medium",
    package: "drizzle-orm",
    vulnVersion: "0.28.0",
    fixedVersion: "0.29.0",
    message: "SQL Injection via unsanitized raw query input",
    rule: "SNYK-JS-DRIZZLEORM-7010000",
  },
];

const sastFindings: RawSecurityFinding[] = [
  {
    kind: "sast",
    severity: "medium",
    file: "src/utils/parse.js",
    line: 42,
    rule: "SNYK-JS-REGEXDOS",
    message: "Potential regular expression denial of service (ReDoS)",
  },
  {
    kind: "sast",
    severity: "high",
    file: "src/db/users.js",
    line: 17,
    rule: "SNYK-JS-HARDCODEDPASSWORD",
    message: "Hardcoded password detected in database connection string",
  },
];

export function loadFixture(): SnykResult {
  return {
    ok: true,
    depFindings,
    sastFindings,
    rawDep,
    rawSast,
    source: "fixture",
  };
}
