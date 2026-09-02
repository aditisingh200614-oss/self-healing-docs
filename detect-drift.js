#!/usr/bin/env node
// detect-drift.js — Component 3: Drift Detection Engine
// Compares actual code function signatures against documented signatures
// and reports meaningful discrepancies.
// No external dependencies. Requires Node.js.

const fs = require("fs");
const path = require("path");

// ---------------------------------------------------------------------------
// 1. Read a file safely, returning content or empty string
// ---------------------------------------------------------------------------
function readFileSafe(filePath) {
  try {
    return fs.readFileSync(filePath, "utf-8");
  } catch {
    return "";
  }
}

// ---------------------------------------------------------------------------
// 2. Parse the actual function signature from a source code file.
//
//    Finds the function declaration like:
//      function login(email, password, rememberMe) {
//    and returns the parameter names as an array.
//
//    Also returns the full signature string for reporting.
// ---------------------------------------------------------------------------
function parseCodeSignature(filePath, functionName) {
  const content = readFileSafe(filePath);
  if (!content) return { params: [], raw: "", error: "cannot read file" };

  // Match: function <name>(<params>) {
  // Handles optional whitespace, newlines inside params, etc.
  const pattern = new RegExp(
    `function\\s+${functionName}\\s*\\(([^)]*)\\)`,
    "s"
  );

  const match = content.match(pattern);
  if (!match) return { params: [], raw: "", error: "function not found" };

  const paramStr = match[1].trim();
  const raw = `${functionName}(${paramStr})`;

  if (!paramStr) return { params: [], raw, error: null };

  const params = paramStr.split(",").map((p) => p.trim()).filter(Boolean);
  return { params, raw, error: null };
}

// ---------------------------------------------------------------------------
// 3. Parse the documented function signature from a markdown file.
//
//    Strategy:
//      a. Find the section heading that matches docSection
//      b. Scan forward until the next heading of equal or higher level
//      c. Within that section, find the first code block (``` ... ```)
//      d. Inside the code block, find a call to the function and extract params
//
//    Falls back to searching the entire file if section not found.
// ---------------------------------------------------------------------------
function parseDocSignature(filePath, functionName, sectionName) {
  const content = readFileSafe(filePath);
  if (!content) return { params: [], raw: "", error: "cannot read file" };

  const lines = content.split("\n");

  // --- Step a: Find the section heading ---
  let sectionStart = -1;
  let sectionLevel = 0;

  for (let i = 0; i < lines.length; i++) {
    const clean = lines[i].replace(/\r$/, "");
    const headingMatch = clean.match(/^(#{1,6})\s+(.+)$/);
    if (headingMatch) {
      const level = headingMatch[1].length;
      const text = headingMatch[2].trim();

      if (text.toLowerCase() === sectionName.toLowerCase()) {
        sectionStart = i;
        sectionLevel = level;
        break;
      }
    }
  }

  // --- Step b: Determine section end (next heading of same or higher level) ---
  let sectionEnd = lines.length;
  if (sectionStart >= 0) {
    for (let i = sectionStart + 1; i < lines.length; i++) {
      const clean = lines[i].replace(/\r$/, "");
      const headingMatch = clean.match(/^(#{1,6})\s+(.+)$/);
      if (headingMatch && headingMatch[1].length <= sectionLevel) {
        sectionEnd = i;
        break;
      }
    }
  }

  // Use the section range, or fall back to the whole file
  const searchStart = sectionStart >= 0 ? sectionStart : 0;
  const searchEnd = sectionStart >= 0 ? sectionEnd : lines.length;

  // --- Step c: Find the first code block in the section ---
  let inCodeBlock = false;
  let codeBlockContent = "";

  for (let i = searchStart; i < searchEnd; i++) {
    const clean = lines[i].replace(/\r$/, "");
    if (clean.trim().startsWith("```")) {
      if (inCodeBlock) {
        break; // end of code block
      } else {
        inCodeBlock = true;
        codeBlockContent = "";
        continue;
      }
    }
    if (inCodeBlock) {
      codeBlockContent += clean + "\n";
    }
  }

  // --- Step d: Find the function call inside the code block ---
  const searchArea = inCodeBlock ? codeBlockContent : lines.slice(searchStart, searchEnd).join("\n");

  const pattern = new RegExp(
    `${functionName}\\s*\\(([^)]*)\\)`,
    "s"
  );

  const match = searchArea.match(pattern);
  if (!match) {
    return { params: [], raw: "", error: "function call not found in docs" };
  }

  const paramStr = match[1].trim();
  const raw = `${functionName}(${paramStr})`;

  if (!paramStr) return { params: [], raw, error: null };

  const params = paramStr.split(",").map((p) => p.trim()).filter(Boolean);
  return { params, raw, error: null };
}

// ---------------------------------------------------------------------------
// 4. Compare code params vs doc params and find discrepancies.
//
//    Returns an array of discrepancy objects:
//      { type: "mismatch" | "extra_in_code" | "missing_in_code", ... }
// ---------------------------------------------------------------------------
function detectDiscrepancies(codeParams, docParams) {
  const discrepancies = [];
  const maxLen = Math.max(codeParams.length, docParams.length);

  for (let i = 0; i < maxLen; i++) {
    const codeParam = codeParams[i] || null;
    const docParam = docParams[i] || null;

    if (codeParam && docParam) {
      // Both exist at this position — check if names match
      if (codeParam !== docParam) {
        discrepancies.push({
          type: "mismatch",
          position: i + 1,
          codeValue: codeParam,
          docValue: docParam,
        });
      }
    } else if (codeParam && !docParam) {
      // Exists in code but not in docs
      discrepancies.push({
        type: "extra_in_code",
        position: i + 1,
        codeValue: codeParam,
        docValue: null,
      });
    } else if (!codeParam && docParam) {
      // Exists in docs but not in code
      discrepancies.push({
        type: "missing_in_code",
        position: i + 1,
        codeValue: null,
        docValue: docParam,
      });
    }
  }

  return discrepancies;
}

// ---------------------------------------------------------------------------
// 5. Format a discrepancy into a human-readable sentence
// ---------------------------------------------------------------------------
function formatDiscrepancy(d) {
  switch (d.type) {
    case "mismatch":
      return `Parameter name mismatch at position ${d.position}: code has "${d.codeValue}", docs say "${d.docValue}"`;
    case "extra_in_code":
      return `Extra parameter in code (not documented): ${d.codeValue}`;
    case "missing_in_code":
      return `Parameter in docs but missing from code: ${d.docValue}`;
    default:
      return `Unknown discrepancy at position ${d.position}`;
  }
}

// ---------------------------------------------------------------------------
// 6. Pretty-print the drift report
// ---------------------------------------------------------------------------
function printReport(result) {
  console.log("=== Drift Detection Report ===\n");

  console.log(`Code signature:\n  ${result.codeSignature}\n`);
  console.log(`Documented signature:\n  ${result.docSignature}\n`);

  if (result.codeError) {
    console.log(`Code parse warning: ${result.codeError}\n`);
  }
  if (result.docError) {
    console.log(`Doc parse warning: ${result.docError}\n`);
  }

  if (result.discrepancies.length === 0) {
    console.log("No drift detected. Code and docs are in sync.");
  } else {
    console.log(`Discrepancies found: ${result.discrepancies.length}\n`);
    result.discrepancies.forEach((d, i) => {
      console.log(`  ${i + 1}. ${formatDiscrepancy(d)}`);
    });
  }

  console.log("");
}

// ---------------------------------------------------------------------------
// 7. Main: detect drift for one code↔doc pair
// ---------------------------------------------------------------------------
function detectDrift(input) {
  const { codeFile, functionName, docFile, docSection } = input;

  const codeSig = parseCodeSignature(codeFile, functionName);
  const docSig = parseDocSignature(docFile, functionName, docSection);

  const discrepancies = detectDiscrepancies(codeSig.params, docSig.params);

  return {
    codeFile,
    docFile,
    functionName,
    codeSignature: codeSig.raw || `${functionName}(?)`,
    docSignature: docSig.raw || `${functionName}(?)`,
    codeError: codeSig.error,
    docError: docSig.error,
    discrepancies,
  };
}

// ---------------------------------------------------------------------------
// 8. Entry point: standalone test mode or JSON file input
// ---------------------------------------------------------------------------
function main() {
  let input;

  if (process.argv[2]) {
    try {
      input = JSON.parse(fs.readFileSync(process.argv[2], "utf-8"));
    } catch (e) {
      console.error(`Error reading input file: ${e.message}`);
      process.exit(1);
    }
  } else {
    // Built-in test case
    input = {
      codeFile: "src/auth.js",
      functionName: "login",
      docFile: "docs/authentication.md",
      docSection: "Login",
    };
  }

  const result = detectDrift(input);
  printReport(result);
}

main();
