#!/usr/bin/env node
// validate-drift.js — Component 4: AI Validator
// Uses an LLM to determine whether detected discrepancies represent
// meaningful documentation drift or false positives.
// Requires Node.js 18+ (built-in fetch). No external dependencies.

const fs = require("fs");
const path = require("path");

// ---------------------------------------------------------------------------
// 1. Provider configuration via environment variables.
//    All three are optional with sensible defaults, so the validator
//    works out-of-the-box for local development with Groq.
//    To swap providers later: change the env vars, nothing else.
// ---------------------------------------------------------------------------
const API_KEY = process.env.GROQ_API_KEY || "";
const BASE_URL =
  process.env.GROQ_BASE_URL || "https://api.groq.com/openai/v1";
const MODEL = process.env.GROQ_MODEL || "openai/gpt-oss-20b";

// ---------------------------------------------------------------------------
// 2. Build the system + user prompt that instructs the LLM to return
//    structured JSON. The schema is strict so downstream components
//    can consume the output programmatically.
// ---------------------------------------------------------------------------
function buildPrompt(input) {
  const { codeSignature, docSignature, discrepancies } = input;

  const discrepancyList = discrepancies
    .map((d, i) => {
      if (d.type === "mismatch") {
        return `${i + 1}. Parameter name mismatch at position ${d.position}: code has "${d.codeValue}", docs say "${d.docValue}"`;
      }
      if (d.type === "extra_in_code") {
        return `${i + 1}. Extra parameter in code (not documented): "${d.codeValue}"`;
      }
      if (d.type === "missing_in_code") {
        return `${i + 1}. Parameter in docs but missing from code: "${d.docValue}"`;
      }
      return `${i + 1}. Unknown discrepancy at position ${d.position}`;
    })
    .join("\n");

  const systemMessage = `You are a technical documentation validator. Your job is to evaluate whether discrepancies between code function signatures and their documentation represent meaningful drift or false positives.

For each discrepancy, consider:
- Whether the names are semantically equivalent (e.g., "email" vs "username" may be the same concept depending on context)
- Whether the parameter is genuinely missing from docs or just omitted for brevity
- Whether the code has changed since the docs were written

You MUST respond with valid JSON matching this exact schema:
{
  "meaningfulDrift": boolean,
  "confidence": number between 0 and 1,
  "explanation": "string explaining your reasoning",
  "validatedDiscrepancies": [
    {
      "type": "mismatch" | "extra_in_code" | "missing_in_code",
      "position": number,
      "codeValue": "string or null",
      "docValue": "string or null",
      "isTruePositive": boolean,
      "reason": "string explaining why this is or is not real drift"
    }
  ]
}

Do not include any text outside the JSON object.`;

  const userMessage = `Evaluate whether the following discrepancies between code and documentation represent meaningful drift.

Code signature:    ${codeSignature}
Doc signature:     ${docSignature}

Detected discrepancies:
${discrepancyList || "(none)"}

Respond with the JSON object described in your instructions.`;

  return { systemMessage, userMessage };
}

// ---------------------------------------------------------------------------
// 3. Call the AI provider using the OpenAI-compatible chat completions
//    endpoint. This works with Groq, OpenAI, and any compatible provider
//    — just change the base URL and model via env vars.
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
      temperature: 0.1, // low temp for deterministic, structured output
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
// 4. Parse the LLM response. Falls back to a safe default if parsing fails.
// ---------------------------------------------------------------------------
function parseAIResponse(raw) {
  try {
    const parsed = JSON.parse(raw);
    // Validate required top-level fields
    if (typeof parsed.meaningfulDrift !== "boolean") {
      throw new Error("missing or invalid 'meaningfulDrift' field");
    }
    if (typeof parsed.confidence !== "number") {
      throw new Error("missing or invalid 'confidence' field");
    }
    return parsed;
  } catch (e) {
    return {
      meaningfulDrift: false,
      confidence: 0,
      explanation: `Failed to parse AI response: ${e.message}. Raw output was: ${raw.slice(0, 500)}`,
      validatedDiscrepancies: [],
      _parseError: true,
    };
  }
}

// ---------------------------------------------------------------------------
// 5. Main validation function. Accepts the output shape from Component 3
//    and returns a structured AI validation result.
//
//    Input (from detect-drift.js):
//      { codeSignature, docSignature, discrepancies: [...] }
//
//    Output:
//      { meaningfulDrift, confidence, explanation, validatedDiscrepancies }
// ---------------------------------------------------------------------------
async function validateDrift(input) {
  const { systemMessage, userMessage } = buildPrompt(input);
  const raw = await callLLM(systemMessage, userMessage);
  return parseAIResponse(raw);
}

// ---------------------------------------------------------------------------
// 6. Pretty-print the validation report
// ---------------------------------------------------------------------------
function printReport(result) {
  console.log("=== AI Validation Report ===\n");
  console.log(`Meaningful drift: ${result.meaningfulDrift}`);
  console.log(`Confidence: ${(result.confidence * 100).toFixed(1)}%`);
  console.log(`Explanation: ${result.explanation}\n`);

  if (result.validatedDiscrepancies.length > 0) {
    console.log(`Validated discrepancies (${result.validatedDiscrepancies.length}):`);
    result.validatedDiscrepancies.forEach((d, i) => {
      const label = d.isTruePositive ? "TRUE POSITIVE" : "FALSE POSITIVE";
      let desc;
      if (d.type === "mismatch") {
        desc = `code "${d.codeValue}" vs docs "${d.docValue}"`;
      } else if (d.type === "extra_in_code") {
        desc = `"${d.codeValue}" (undocumented)`;
      } else if (d.type === "missing_in_code") {
        desc = `"${d.docValue}" (in docs only)`;
      } else {
        desc = `position ${d.position}`;
      }
      console.log(`  ${i + 1}. [${label}] ${desc}`);
      console.log(`     Reason: ${d.reason}`);
    });
  } else {
    console.log("No discrepancies to validate.");
  }

  console.log("");
}

// ---------------------------------------------------------------------------
// 7. Entry point: standalone test mode or JSON file input
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
      codeSignature: "login(email, password, rememberMe)",
      docSignature: "login(username, password)",
      discrepancies: [
        {
          type: "mismatch",
          position: 1,
          codeValue: "email",
          docValue: "username",
        },
        {
          type: "extra_in_code",
          position: 3,
          codeValue: "rememberMe",
          docValue: null,
        },
      ],
    };
  }

  try {
    const result = await validateDrift(input);
    printReport(result);

    // Also dump the full JSON for downstream consumption
    if (process.argv.includes("--json")) {
      console.log(JSON.stringify(result, null, 2));
    }
  } catch (e) {
    console.error(`Validation failed: ${e.message}`);
    process.exit(1);
  }
}

main();
