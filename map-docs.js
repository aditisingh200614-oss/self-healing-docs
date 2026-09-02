#!/usr/bin/env node
// map-docs.js — Component 2: Documentation Mapper
// Maps changed code to related documentation files and sections.
// No external dependencies. Requires Node.js.

const fs = require("fs");
const path = require("path");

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------
const DOCS_DIR = "docs"; // where to look for documentation

// ---------------------------------------------------------------------------
// 1. Discover all markdown files in the docs directory
// ---------------------------------------------------------------------------
function discoverDocFiles(docsDir) {
  const files = [];

  function walk(dir) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.name.endsWith(".md")) {
        files.push(fullPath);
      }
    }
  }

  walk(docsDir);
  return files;
}

// ---------------------------------------------------------------------------
// 2. Read a file and return its content (or empty string on failure)
// ---------------------------------------------------------------------------
function readFileSafe(filePath) {
  try {
    return fs.readFileSync(filePath, "utf-8");
  } catch {
    return "";
  }
}

// ---------------------------------------------------------------------------
// 3. LAYER 1 — File name similarity
//
//    Extract the "core" name from both the source file and the doc file,
//    then check if one contains the other or if they share a root.
//
//    Example:  "src/auth.js"  → core = "auth"
//              "docs/authentication.md" → core = "authentication"
//              "auth" is a substring of "authentication" → match!
// ---------------------------------------------------------------------------
function extractCoreName(filePath) {
  const base = path.basename(filePath, path.extname(filePath)); // e.g. "auth", "authentication"
  return base.toLowerCase();
}

function fileSimilarityScore(sourceFile, docFile) {
  const srcCore = extractCoreName(sourceFile);
  const docCore = extractCoreName(docFile);

  // Exact match
  if (srcCore === docCore) return { score: 1.0, reason: `exact name match "${srcCore}"` };

  // One contains the other
  if (docCore.includes(srcCore)) return { score: 0.8, reason: `doc name contains "${srcCore}"` };
  if (srcCore.includes(docCore)) return { score: 0.7, reason: `source name contains "${docCore}"` };

  // Share a common prefix (at least 3 chars)
  const minLen = Math.min(srcCore.length, docCore.length);
  let sharedPrefix = 0;
  for (let i = 0; i < minLen; i++) {
    if (srcCore[i] === docCore[i]) sharedPrefix++;
    else break;
  }
  if (sharedPrefix >= 3) {
    return { score: 0.5, reason: `shared prefix "${srcCore.slice(0, sharedPrefix)}"` };
  }

  return { score: 0, reason: "no name similarity" };
}

// ---------------------------------------------------------------------------
// 4. LAYER 2 — Directory name similarity
//
//    Compare the parent directory names of source and doc files.
//    Since our test repo uses "src" and "docs" this is unlikely to match
//    on its own, but it provides a fallback for projects with structured
//    directories like src/auth/ → docs/auth/.
// ---------------------------------------------------------------------------
function dirSimilarityScore(sourceFile, docFile) {
  const srcDir = path.basename(path.dirname(sourceFile)).toLowerCase();
  const docDir = path.basename(path.dirname(docFile)).toLowerCase();

  if (srcDir === docDir) return { score: 1.0, reason: `exact dir match "${srcDir}"` };
  if (srcDir === "src" && docDir === "docs") return { score: 0.2, reason: "src→docs convention" };

  return { score: 0, reason: "no dir similarity" };
}

// ---------------------------------------------------------------------------
// 5. LAYER 3 — Markdown section matching
//
//    Parse all headings from the doc file and check if any heading
//    contains the function name or a related keyword.
//    Also checks if the function name appears anywhere in the doc body.
// ---------------------------------------------------------------------------
function parseHeadings(content) {
  const headings = [];
  const lines = content.split("\n");
  for (const rawLine of lines) {
    const line = rawLine.replace(/\r$/, ""); // handle Windows line endings
    const match = line.match(/^(#{1,6})\s+(.+)$/);
    if (match) {
      headings.push({ level: match[1].length, text: match[2].trim() });
    }
  }
  return headings;
}

function sectionMatchScore(docContent, functionName) {
  const headings = parseHeadings(docContent);
  const lowerFn = functionName.toLowerCase();

  // Check if any heading mentions the function name
  for (const h of headings) {
    const lowerHeading = h.text.toLowerCase();
    if (lowerHeading === lowerFn) {
      return { score: 1.0, reason: `heading matches "${functionName}" exactly`, section: h.text };
    }
    if (lowerHeading.includes(lowerFn)) {
      return { score: 0.9, reason: `heading contains "${functionName}"`, section: h.text };
    }
  }

  // Check if the function name appears anywhere in the doc body
  const bodyLower = docContent.toLowerCase();
  if (bodyLower.includes(lowerFn)) {
    return { score: 0.6, reason: `"${functionName}" mentioned in doc body` };
  }

  return { score: 0, reason: "function not mentioned in doc" };
}

// ---------------------------------------------------------------------------
// 6. Combine the three layers into a final mapping score
// ---------------------------------------------------------------------------
function computeMappingScore(sourceFile, functionName, docFile, docContent) {
  const layer1 = fileSimilarityScore(sourceFile, docFile);
  const layer2 = dirSimilarityScore(sourceFile, docFile);
  const layer3 = sectionMatchScore(docContent, functionName);

  // Weighted combination: file name is strongest, section match is decisive
  const finalScore =
    layer1.score * 0.35 +
    layer2.score * 0.15 +
    layer3.score * 0.50;

  const reasons = [];
  if (layer1.score > 0) reasons.push(`file name: ${layer1.reason}`);
  if (layer2.score > 0) reasons.push(`dir: ${layer2.reason}`);
  if (layer3.score > 0) reasons.push(`section: ${layer3.reason}`);

  return {
    score: Math.round(finalScore * 100) / 100,
    reasons: reasons.join("; ") || "no match",
    section: layer3.section || null,
  };
}

// ---------------------------------------------------------------------------
// 7. Main mapper: for each code change, find the best-matching doc
// ---------------------------------------------------------------------------
function mapChangesToDocs(changes, docsDir) {
  const docFiles = discoverDocFiles(docsDir);

  if (docFiles.length === 0) {
    return [];
  }

  const results = [];

  for (const change of changes) {
    let bestDoc = null;
    let bestScore = 0;
    let bestMeta = {};

    for (const docFile of docFiles) {
      const content = readFileSafe(docFile);
      const mapping = computeMappingScore(change.file, change.function, docFile, content);

      if (mapping.score > bestScore) {
        bestScore = mapping.score;
        bestDoc = docFile;
        bestMeta = mapping;
      }
    }

    results.push({
      sourceFile: change.file,
      changedFunction: change.function,
      matchedDoc: bestDoc,
      matchedSection: bestMeta.section || null,
      score: bestMeta.score || 0,
      reason: bestMeta.reasons || "no match",
    });
  }

  return results;
}

// ---------------------------------------------------------------------------
// 8. Pretty-print the report
// ---------------------------------------------------------------------------
function printReport(results) {
  console.log("=== Documentation Mapping Report ===\n");

  for (const r of results) {
    console.log("Changed code:");
    console.log(`  File: ${r.sourceFile}`);
    console.log(`  Function: ${r.changedFunction}()`);
    console.log("");
    console.log("Related documentation:");
    console.log(`  File: ${r.matchedDoc}`);
    if (r.matchedSection) {
      console.log(`  Section: ${r.matchedSection}`);
    }
    console.log(`  Score: ${r.score}`);
    console.log(`  Reason: ${r.reason}`);
    console.log("");
  }
}

// ---------------------------------------------------------------------------
// 9. Standalone test mode: run with hardcoded input if no args given,
//    or accept a JSON file path as an argument.
// ---------------------------------------------------------------------------
function main() {
  let changes;

  if (process.argv[2]) {
    // Load changes from a JSON file
    try {
      changes = JSON.parse(fs.readFileSync(process.argv[2], "utf-8"));
    } catch (e) {
      console.error(`Error reading input file: ${e.message}`);
      process.exit(1);
    }
  } else {
    // Built-in test case: the login() change in src/auth.js
    changes = [
      { file: "src/auth.js", function: "login" },
    ];
  }

  const results = mapChangesToDocs(changes, DOCS_DIR);
  printReport(results);
}

main();
