#!/usr/bin/env node
// analyze-changes.js — Component 1: Change Analyzer
// Identifies what changed in a Git repo (files, functions, lines).
// No external dependencies. Requires Node.js and Git.

const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

// ---------------------------------------------------------------------------
// 1. Run a shell command and return trimmed stdout
// ---------------------------------------------------------------------------
function run(cmd) {
  return execSync(cmd, { encoding: "utf-8" }).trim();
}

// ---------------------------------------------------------------------------
// 2. Get the unified diff between the working tree and the last commit
// ---------------------------------------------------------------------------
function getDiff(ref = "HEAD") {
  try {
    return run(`git diff ${ref}`);
  } catch {
    return "";
  }
}

// ---------------------------------------------------------------------------
// 3. Parse unified diff into a structured array of file changes
//    Each entry: { file, added: string[], removed: string[] }
// ---------------------------------------------------------------------------
function parseDiff(diffText) {
  if (!diffText) return [];

  const files = [];
  let current = null;

  for (const line of diffText.split("\n")) {
    // New file section
    if (line.startsWith("diff --git")) {
      const match = line.match(/b\/(.+)$/);
      if (match) {
        current = { file: match[1], added: [], removed: [] };
        files.push(current);
      }
      continue;
    }

    if (!current) continue;

    // Skip file metadata lines
    if (line.startsWith("---") || line.startsWith("+++") || line.startsWith("@@")) {
      continue;
    }

    // Added line
    if (line.startsWith("+")) {
      current.added.push(line.slice(1));
    }
    // Removed line
    else if (line.startsWith("-")) {
      current.removed.push(line.slice(1));
    }
  }

  return files;
}

// ---------------------------------------------------------------------------
// 4. Read a file and build a map of line ranges → function names.
//    Handles simple `function name() { ... }` declarations.
//    Returns an array of { name, startLine, endLine }.
// ---------------------------------------------------------------------------
function buildFunctionMap(filePath) {
  const functions = [];
  const fullPath = path.resolve(filePath);

  let content;
  try {
    content = fs.readFileSync(fullPath, "utf-8");
  } catch {
    return functions;
  }

  const lines = content.split("\n");
  const stack = []; // stack of { name, startLine, braceDepth }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNum = i + 1;

    // Detect function declarations:  function foo(...) {
    const funcMatch = line.match(/\bfunction\s+(\w+)\s*\(/);
    if (funcMatch) {
      stack.push({ name: funcMatch[1], startLine: lineNum, braceDepth: 0 });
    }

    // Count braces for the current (topmost) function
    if (stack.length > 0) {
      for (const ch of line) {
        if (ch === "{") stack[stack.length - 1].braceDepth++;
        if (ch === "}") stack[stack.length - 1].braceDepth--;
      }

      // When depth returns to 0 the function body is complete
      if (stack[stack.length - 1].braceDepth <= 0) {
        const fn = stack.pop();
        functions.push({ name: fn.name, startLine: fn.startLine, endLine: lineNum });
      }
    }
  }

  return functions;
}

// ---------------------------------------------------------------------------
// 5. For a given line number, return the function that contains it (or null)
// ---------------------------------------------------------------------------
function findFunctionAtLine(functionMap, lineNum) {
  for (const fn of functionMap) {
    if (lineNum >= fn.startLine && lineNum <= fn.endLine) {
      return fn.name;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// 6. For a changed line, try to figure out which function it belongs to
//    by reading the current file and scanning for the function that
//    contains the line number in the file.
//
//    Because we only have the *added* text (not the original line number),
//    we do a best-effort match: search the current file for the changed
//    text and, if found, use that line number.
// ---------------------------------------------------------------------------
function detectFunctionFromFile(filePath, changedText) {
  const fullPath = path.resolve(filePath);
  let content;
  try {
    content = fs.readFileSync(fullPath, "utf-8");
  } catch {
    return null;
  }

  const trimmed = changedText.trim();
  if (!trimmed) return null;

  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() === trimmed) {
      const fnMap = buildFunctionMap(filePath);
      return findFunctionAtLine(fnMap, i + 1);
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// 7. Main: analyse changes and print a structured report
// ---------------------------------------------------------------------------
function analyse(ref) {
  const diffText = getDiff(ref);
  const changes = parseDiff(diffText);

  if (changes.length === 0) {
    console.log("No changes detected.");
    return;
  }

  const results = [];

  for (const { file, added, removed } of changes) {
    // Only analyse source-code files (skip binary, config, docs, etc.)
    const ext = path.extname(file);
    const isSource = [".js", ".ts", ".jsx", ".tsx", ".mjs", ".cjs"].includes(ext);

    const fileResult = { file, functions: [], lines: [] };

    // Collect the changed lines for this file
    for (const line of added) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      const funcName = isSource ? detectFunctionFromFile(file, trimmed) : null;
      fileResult.lines.push({ type: "added", text: trimmed, function: funcName });
      if (funcName && !fileResult.functions.includes(funcName)) {
        fileResult.functions.push(funcName);
      }
    }

    for (const line of removed) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      fileResult.lines.push({ type: "removed", text: trimmed, function: null });
    }

    results.push(fileResult);
  }

  // ---- Pretty-print the report ----
  console.log("=== Change Analysis Report ===\n");

  for (const r of results) {
    console.log(`Changed file: ${r.file}`);

    if (r.functions.length > 0) {
      for (const fn of r.functions) {
        console.log(`  Changed function: ${fn}()`);
      }
    }

    for (const l of r.lines) {
      const label = l.type === "added" ? "Added" : "Removed";
      const prefix = l.function ? ` [in ${l.function}()]` : "";
      console.log(`  Change: ${label}${prefix} → ${l.text}`);
    }

    console.log("");
  }

  return results;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------
const ref = process.argv[2] || "HEAD";
analyse(ref);
