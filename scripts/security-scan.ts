import { readdir, readFile } from "node:fs/promises";
import { extname, join, relative } from "node:path";

const root = process.cwd();
const skippedDirectories = new Set([
  ".git",
  "node_modules",
  "dist",
  "coverage",
  "data",
  "logs",
  "artifacts",
]);
const textExtensions = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".json",
  ".md",
  ".yml",
  ".yaml",
  ".toml",
  ".env",
]);
const secretPatterns: Array<{ label: string; pattern: RegExp }> = [
  { label: "private key", pattern: /\b0x[a-fA-F0-9]{64}\b/ },
  { label: "live Stripe key", pattern: /\bsk_live_[A-Za-z0-9]{16,}\b/ },
  { label: "AWS access key", pattern: /\bAKIA[A-Z0-9]{16}\b/ },
  {
    label: "assigned credential",
    pattern:
      /\b(?:PRIVATE_KEY|POLY_API_SECRET|BUILDER_SECRET|BUILDER_PASSPHRASE)\s*=\s*["']?[^\s"'$<{]{8,}/,
  },
];
const explicitFixtureAllowlist = new Set([
  "test/engine/auth-hardening.test.ts",
  "test/engine/type3-account-model.test.ts",
]);

async function files(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const result: string[] = [];
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (skippedDirectories.has(entry.name)) continue;
      result.push(...(await files(join(directory, entry.name))));
      continue;
    }
    const file = join(directory, entry.name);
    if (
      textExtensions.has(extname(entry.name)) ||
      entry.name.startsWith(".env")
    ) {
      result.push(file);
    }
  }
  return result;
}

const findings: string[] = [];
for (const file of await files(root)) {
  const path = relative(root, file).replaceAll("\\", "/");
  if (path === "scripts/security-scan.ts") continue;
  if (path.startsWith("AI_WORKSPACE/")) continue;
  const content = await readFile(file, "utf8");
  for (const [index, line] of content.split(/\r?\n/).entries()) {
    for (const candidate of secretPatterns) {
      if (candidate.pattern.test(line)) {
        if (explicitFixtureAllowlist.has(path)) continue;
        findings.push(`${path}:${index + 1}: ${candidate.label}`);
      }
    }
  }
}

if (findings.length > 0) {
  console.error("Potential committed secrets detected:");
  for (const finding of findings) console.error(finding);
  process.exitCode = 1;
} else {
  console.log("Secret scan passed");
}
