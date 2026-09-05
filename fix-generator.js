#!/usr/bin/env node
// fix-generator.js — Component 5: Fix Generator
// Generates suggested documentation corrections from validated drift.
// Uses Groq AI (OpenAI-compatible) to produce corrected documentation text.
// No external dependencies. Requires Node.js 18+ (built-in fetch).
//
// SAFEGUARDS:
//   1. proposedText is constrained to information from the code signature
//      and existing documentation only — no invented behavior/examples.
//   2. currentText is extracted verbatim from the actual doc file so
//      Component 6 can verify it before replacing anything.
//   3. If the AI is uncertain, needsReview: true is set instead of
//      confidently producing a fix.
//   4. The documentation section heading is included in every output fix.
//   5. No documentation files are modified — output is structured JSON only.

const fs = require("fs");
const path = require("path");

// ---------------------------------------------------------------------------
// 1. Provider configuration via environment variables.
//    Identical pattern to Component 4 (validate-drift.js).
// ---------------------------------------------------------------------------
const API_KEY = process.env.GROQ_API_KEY || "";
const BASE_URL =
  process.env.GROQ_BASE_URL || "https://api.groq.com/openai/v1";
const MODEL = process.env.GROQ_MODEL || "openai/gpt-oss-20b";

// Confidence threshold: fixes below this are flagged for human review.
const REVIEW_THRESHOLD = 0.7;

// ---------------------------------------------------------------------------
// 2. Extract a documentation section verbatim.
//
//    Finds the heading matching `sectionName`, then captures everything
//    up to (but not including) the next heading of equal or higher level.
//    This is the EXACT text that will become `currentText` in the output,
//    so Component 6 can do a safe string replacement later.
// ---------------------------------------------------------------------------
function extractSection(docContent, sectionName) {
  const lines = docContent.split("\n");

  // Find the heading
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

  if (sectionStart === -1) {
    return { text: null, startLine: -1, endLine: -1, error: "section not found" };
  }

  // Find the end: next heading of same or higher level
  let sectionEnd = lines.length;
  for (let i = sectionStart + 1; i < lines.length; i++) {
    const clean = lines[i].replace(/\r$/, "");
    const headingMatch = clean.match(/^(#{1,6})\s+(.+)$/);
    if (headingMatch && headingMatch[1].length <= sectionLevel) {
      sectionEnd = i;
      break;
    }
  }

  // Extract the section including its heading
  const sectionLines = lines.slice(sectionStart, sectionEnd);
  const text = sectionLines.join("\n");

  return { text, startLine: sectionStart, endLine: sectionEnd, error: null };
}

// ---------------------------------------------------------------------------
// 3. Read a file safely, returning content or empty string.
// ---------------------------------------------------------------------------
function readFileSafe(filePath) {
  try {
    return fs.readFileSync(filePath, "utf-8");
  } catch {
    return "";
  }
}

// ---------------------------------------------------------------------------
// 4. Build the system + user prompt for the fix generator.
//
//    SAFEGUARD 1: The system prompt explicitly constrains the AI to only
//    use information from the code signature and existing documentation.
//    It must not invent behavior, examples, parameters, or explanations.
//
//    SAFEGUARD 3: The system prompt instructs the AI to set needsReview
//    to true when uncertain rather than guessing.
// ---------------------------------------------------------------------------
function buildPrompt(input) {
  const { codeSignature, currentDocText, docSection, validatedDiscrepancies } =
    input;

  // Filter to only true-positive discrepancies
  const truePositives = validatedDiscrepancies.filter((d) => d.isTruePositive);

  const discrepancyList = truePositives
    .map((d, i) => {
      if (d.type === "mismatch") {
        return `${i + 1}. PARAMETER RENAME at position ${d.position}: code uses "${d.codeValue}", docs say "${d.docValue}" — update docs to use "${d.codeValue}"`;
      }
      if (d.type === "extra_in_code") {
        return `${i + 1}. MISSING PARAMETER at position ${d.position}: code has "${d.codeValue}" which is not documented — add "${d.codeValue}" to docs`;
      }
      if (d.type === "missing_in_code") {
        return `${i + 1}. STALE PARAMETER at position ${d.position}: docs reference "${d.docValue}" which no longer exists in code — remove "${d.docValue}" from docs`;
      }
      return `${i + 1}. Unknown discrepancy`;
    })
    .join("\n");

  const systemMessage = `You are a technical documentation editor. You generate corrected documentation based on validated discrepancies between code and docs.

CRITICAL CONSTRAINTS — you MUST follow these rules:

1. ONLY make changes that directly correspond to the validated discrepancies listed below. Do NOT rewrite prose, change formatting, reorder content, or add any information not explicitly supported by the code signature.

2. For PARAMETER RENAME: change the parameter name in the docs from the old name to the new name. Do not change anything else.

3. For MISSING PARAMETER: add the parameter to the documentation with a brief factual description derived ONLY from the parameter name and its position in the signature. Do NOT invent behavior, default values, types, or examples that are not present in the existing docs.

4. For STALE PARAMETER: remove the parameter from the documentation. Do not rewrite surrounding text.

5. Preserve the existing documentation style, tone, and structure exactly.

6. If you are NOT confident about the correct correction for ANY discrepancy, set needsReview to true and include an explanation of your uncertainty. Do NOT guess.

7. The currentDocText you receive is the EXACT text from the documentation file. Your proposedText must be a valid replacement that maintains the same structure.

You MUST respond with valid JSON matching this exact schema:
{
  "fixes": [
    {
      "section": "heading name",
      "currentText": "exact text from the docs (copy verbatim)",
      "proposedText": "corrected text",
      "changes": [
        {
          "description": "what was changed and why",
          "type": "mismatch | extra_in_code | missing_in_code",
          "confidence": number between 0 and 1
        }
      ],
      "confident": boolean
    }
  ],
  "needsReview": boolean,
  "explanation": "summary of all changes"
}

Do not include any text outside the JSON object.`;

  const userMessage = `Generate corrected documentation for the "${docSection}" section.

Code signature (the ground truth):
  ${codeSignature}

Current documentation section content:
---
${currentDocText}
---

Validated discrepancies to fix:
${truePositives.length > 0 ? discrepancyList : "(no true-positive discrepancies — return empty fixes array)"}

Rules:
- Only fix the discrepancies listed above.
- Do not invent information not present in the code signature or existing docs.
- If uncertain about any fix, set needsReview to true.
- Return the JSON object described in your instructions.`;

  return { systemMessage, userMessage };
}

// ---------------------------------------------------------------------------
// 5. Call the AI provider — identical pattern to Component 4.
// ---------------------------------------------------------------------------
async function callLLM(systemMessage, userMessage) {
  if (!API_KEY) {
    throw new Error(
      "GROQ_API_KEY is not set. Export it before running:\n" +
        '  export GROQ_API_KEY="gsk_..."'
    );
  }

  const url = `${BASE_URL}/chat/completions`;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${API_KEY}`,
    },
    body: JSON.stringify({
      model: MODEL,
      messages: [
        { role: "system", content: systemMessage },
        { role: "user", content: userMessage },
      ],
      temperature: 0.1,
      response_format: { type: "json_object" },
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`API request failed (${response.status}): ${body}`);
  }

  const data = await response.json();
  return data.choices[0].message.content;
}

// ---------------------------------------------------------------------------
// 6. Parse and validate the AI response.
//
//    SAFEGUARD 2: Verify that currentText in each fix matches the actual
//    extracted section text. If the AI returned something different,
//    we flag it for review.
//
//    SAFEGUARD 3: If overall confidence is below the threshold, force
//    needsReview: true.
// ---------------------------------------------------------------------------
function parseAIResponse(raw, expectedSectionText) {
  try {
    const parsed = JSON.parse(raw);

    // Validate top-level structure
    if (!Array.isArray(parsed.fixes)) {
      throw new Error("missing or invalid 'fixes' array");
    }

    if (typeof parsed.needsReview !== "boolean") {
      parsed.needsReview = true; // default to review if AI didn't say
    }

    // Validate each fix
    for (const fix of parsed.fixes) {
      if (typeof fix.section !== "string" || !fix.section) {
        throw new Error("fix missing 'section' field");
      }
      if (typeof fix.currentText !== "string" || !fix.currentText) {
        throw new Error("fix missing 'currentText' field");
      }
      if (typeof fix.proposedText !== "string" || !fix.proposedText) {
        throw new Error("fix missing 'proposedText' field");
      }
      if (!Array.isArray(fix.changes)) {
        fix.changes = [];
      }

      // SAFEGUARD 2: Verify currentText matches the extracted section
      if (expectedSectionText && fix.currentText !== expectedSectionText) {
        fix.currentTextMismatch = true;
        fix.currentText = expectedSectionText; // correct it to the real text
        fix.needsReview = true;
        parsed.needsReview = true;
      }
    }

    // SAFEGUARD 3: Check per-fix confidence thresholds
    for (const fix of parsed.fixes) {
      const lowConfidence = fix.changes.some(
        (c) => typeof c.confidence === "number" && c.confidence < REVIEW_THRESHOLD
      );
      if (lowConfidence || fix.confident === false) {
        fix.needsReview = true;
        parsed.needsReview = true;
      }
    }

    // SAFEGUARD 1: Validate that proposedText contains the expected
    // parameter names from the code signature (lightweight sanity check).
    // This is a heuristic — it catches cases where the AI forgot to
    // rename a parameter or add a missing one.
    for (const fix of parsed.fixes) {
      if (fix.changes) {
        for (const change of fix.changes) {
          if (change.type === "mismatch" && change.confidence >= REVIEW_THRESHOLD) {
            // The proposed text should contain the codeValue parameter name
            // somewhere (we can't check exact position, just presence)
            // This is a soft check — we don't fail, we flag for review
            if (change.codeValue && !fix.proposedText.includes(change.codeValue)) {
              fix.needsReview = true;
              parsed.needsReview = true;
            }
          }
        }
      }
    }

    // Compute overall confidence from individual change confidences
    const allConfidences = parsed.fixes
      .flatMap((f) => f.changes || [])
      .map((c) => c.confidence)
      .filter((c) => typeof c === "number");

    parsed.overallConfidence =
      allConfidences.length > 0
        ? allConfidences.reduce((a, b) => a + b, 0) / allConfidences.length
        : 0;

    // SAFEGUARD 3: Force review if overall confidence is low
    if (parsed.overallConfidence < REVIEW_THRESHOLD) {
      parsed.needsReview = true;
    }

    return parsed;
  } catch (e) {
    return {
      fixes: [],
      needsReview: true,
      explanation: `Failed to parse AI response: ${e.message}. Raw output was: ${raw.slice(0, 500)}`,
      overallConfidence: 0,
      _parseError: true,
    };
  }
}

// ---------------------------------------------------------------------------
// 7. Main fix generation function.
//
//    Accepts the combined output from upstream components and returns
//    structured JSON that Component 6 can consume.
// ---------------------------------------------------------------------------
async function generateFix(input) {
  const { docFile, docSection, codeSignature, functionName, validatedDrift } =
    input;

  // Read the actual doc file to extract the exact section text
  const docContent = readFileSafe(docFile);
  if (!docContent) {
    return {
      fixes: [],
      needsReview: true,
      explanation: `Cannot read documentation file: ${docFile}`,
      overallConfidence: 0,
    };
  }

  // SAFEGUARD 2: Extract the section verbatim from the actual file
  const { text: currentDocText, error: sectionError } = extractSection(
    docContent,
    docSection
  );

  if (sectionError) {
    return {
      fixes: [],
      needsReview: true,
      explanation: `Cannot find section "${docSection}" in ${docFile}: ${sectionError}`,
      overallConfidence: 0,
    };
  }

  // Filter to true-positive discrepancies
  const truePositives = (validatedDrift.validatedDiscrepancies || []).filter(
    (d) => d.isTruePositive
  );

  if (truePositives.length === 0) {
    return {
      fixes: [],
      needsReview: false,
      explanation: "No validated true-positive discrepancies to fix.",
      overallConfidence: 1,
    };
  }

  // Build the prompt
  const promptInput = {
    codeSignature,
    currentDocText,
    docSection,
    validatedDiscrepancies: truePositives,
  };

  const { systemMessage, userMessage } = buildPrompt(promptInput);

  // Call the LLM
  const raw = await callLLM(systemMessage, userMessage);

  // Parse and validate the response
  // SAFEGUARD 2: Pass expectedSectionText for verification
  const result = parseAIResponse(raw, currentDocText);

  // Add metadata
  result._meta = {
    generatedBy: "fix-generator",
    version: "1.0.0",
    sourceFile: docFile,
    section: docSection,
    codeSignature,
    truePositiveCount: truePositives.length,
  };

  return result;
}

// ---------------------------------------------------------------------------
// 8. Pretty-print the fix report for human review
// ---------------------------------------------------------------------------
function printReport(result) {
  console.log("=== Fix Generator Report ===\n");

  console.log(`Overall confidence: ${(result.overallConfidence * 100).toFixed(1)}%`);
  console.log(`Needs review: ${result.needsReview}`);
  console.log(`Explanation: ${result.explanation}\n`);

  if (result.fixes.length === 0) {
    console.log("No fixes generated.");
    return;
  }

  for (let i = 0; i < result.fixes.length; i++) {
    const fix = result.fixes[i];
    console.log(`--- Fix ${i + 1}: Section "${fix.section}" ---`);
    console.log(`Confident: ${fix.confident !== false ? "yes" : "no"}`);
    if (fix.currentTextMismatch) {
      console.log("⚠ WARNING: AI returned mismatched currentText — corrected to actual text");
    }
    console.log(`\nCurrent text:\n  ${fix.currentText.split("\n").join("\n  ")}`);
    console.log(`\nProposed text:\n  ${fix.proposedText.split("\n").join("\n  ")}`);
    console.log(`\nChanges (${fix.changes.length}):`);
    for (const change of fix.changes) {
      const conf = typeof change.confidence === "number"
        ? ` (${(change.confidence * 100).toFixed(0)}%)`
        : "";
      const label = change.type === "missing_in_code" ? "missing_in_docs" : change.type;
      console.log(`  - [${label}] ${change.description}${conf}`);
    }
    console.log("");
  }

  if (result.needsReview) {
    console.log("⚠ This output requires human review before applying.");
  }

  console.log("");
}

// ---------------------------------------------------------------------------
// 9. Entry point: standalone test mode or JSON file input
// ---------------------------------------------------------------------------
async function main() {
  let input;

  if (process.argv[2]) {
    // Load input from a JSON file
    try {
      input = JSON.parse(fs.readFileSync(process.argv[2], "utf-8"));
    } catch (e) {
      console.error(`Error reading input file: ${e.message}`);
      process.exit(1);
    }
  } else {
    // Built-in test case matching the existing repo's login() example
    input = {
      docFile: "docs/authentication.md",
      docSection: "Login",
      codeFile: "src/auth.js",
      functionName: "login",
      codeSignature: "login(email, password, rememberMe)",
      docSignature: "login(username, password)",
      validatedDrift: {
        meaningfulDrift: true,
        confidence: 0.92,
        explanation: "Parameter renamed from username to email; new parameter rememberMe is undocumented.",
        validatedDiscrepancies: [
          {
            type: "mismatch",
            position: 1,
            codeValue: "email",
            docValue: "username",
            isTruePositive: true,
            reason: "Code uses 'email' but docs say 'username' — this is a real naming drift.",
          },
          {
            type: "extra_in_code",
            position: 3,
            codeValue: "rememberMe",
            docValue: null,
            isTruePositive: true,
            reason: "Code accepts a third parameter 'rememberMe' that is not documented.",
          },
        ],
      },
    };
  }

  try {
    const result = await generateFix(input);
    printReport(result);

    // Also dump the full JSON for downstream consumption
    if (process.argv.includes("--json")) {
      console.log(JSON.stringify(result, null, 2));
    }
  } catch (e) {
    console.error(`Fix generation failed: ${e.message}`);
    process.exit(1);
  }
}

main();
