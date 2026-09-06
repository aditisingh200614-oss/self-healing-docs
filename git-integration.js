#!/usr/bin/env node
// git-integration.js — Component 7: Git Integration
// Handles Git operations AFTER Component 6 has safely applied a documentation
// fix. Shows status and diff, asks for explicit human confirmation, and only
// then stages the intended documentation files and creates a commit.
//
// Hard safety rules enforced by this script:
//   - NEVER pushes to GitHub or any remote.
//   - NEVER creates a GitHub PR.
//   - NEVER modifies documentation files itself.
//   - NEVER uses force push, reset, checkout, or any destructive command.
//   - NEVER calls the Groq API or any external service.
//   - Commits ONLY after the human explicitly confirms with "y".
//   - Node.js built-in modules only — zero external dependencies.

const { execFile } = require("child_process");
const fs = require("fs");
const path = require("path");

// Default commit message (requirement 6). Overridable via:
//   node git-integration.js "My custom commit message"
const DEFAULT_COMMIT_MESSAGE = "Update documentation automatically";

// The exact confirmation prompt required by the spec (requirement 4).
const CONFIRM_PROMPT = "Create this Git commit? (y/n): ";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Run a git subcommand safely. Never throws; never uses a shell. */
function git(args, cwd) {
  return new Promise((resolve) => {
    execFile(
      "git",
      args,
      { cwd: cwd || process.cwd(), windowsHide: true, maxBuffer: 1024 * 1024 * 10 },
      (error, stdout, stderr) => {
        resolve({
          ok: !error,
          code: error && typeof error.code === "number" ? error.code : null,
          stdout: stdout || "",
          stderr: (stderr || "").trim(),
          error,
        });
      }
    );
  });
}

/** Read a file's content, or null on failure (mirrors apply-fix.js style). */
function readFileSafe(filePath) {
  try {
    return fs.readFileSync(filePath, "utf-8");
  } catch {
    return null;
  }
}

/** Prompt the user and resolve true only for an explicit yes. */
function askForConfirmation(promptText) {
  return new Promise((resolve) => {
    process.stdout.write(promptText);
    process.stdin.setEncoding("utf-8");
    process.stdin.once("data", (data) => {
      const answer = String(data).trim().toLowerCase();
      resolve(answer === "y" || answer === "yes");
    });
  });
}

/**
 * Sanity-check the commit message: non-empty, single line, no newlines.
 * Git refuses messages containing stray newlines, so we collapse them.
 */
function sanitizeCommitMessage(raw) {
  const collapsed = String(raw || "").replace(/\r?\n/g, " ").replace(/\s+/g, " ").trim();
  return collapsed || DEFAULT_COMMIT_MESSAGE;
}

/** Extract repo-relative paths like "docs/foo.md" from `git status --porcelain`. */
function parsePorcelainPaths(porcelainOutput) {
  const paths = [];
  for (const line of porcelainOutput.split("\n")) {
    if (!line) continue;
    // Format: XY <space> <path>   (X = index status, Y = worktree status)
    const status = line.slice(0, 2);
    let file = line.slice(3);
    // Untracked entries are "?? path"; treat them as worktree changes too.
    if (!status.trim() && !file) continue;
    // Rename entries look like "R  old -> new"; keep the new side.
    const arrow = file.indexOf(" -> ");
    if (arrow !== -1) file = file.slice(arrow + 4);
    // Strip surrounding double quotes that git uses for exotic filenames.
    if (file.startsWith('"') && file.endsWith('"')) {
      file = file.slice(1, -1);
    }
    paths.push(file.trim());
  }
  return paths;
}

// ---------------------------------------------------------------------------
// Step 1: Verify the current directory is inside a Git repository.
//         Also records the repo root so all later commands run from there.
// ---------------------------------------------------------------------------
async function assertInsideGitRepository() {
  const root = await git(["rev-parse", "--show-toplevel"]);

  if (!root.ok) {
    console.error("ERROR: This directory is not inside a Git repository.");
    console.error("");
    if (root.stderr) {
      console.error(`Git said: ${root.stderr}`);
    }
    console.error("Run this script from a directory inside your documentation repository.");
    return null;
  }

  const toplevel = root.stdout.trim();
  console.log(`✓ Inside a Git repository: ${toplevel}`);
  return toplevel;
}

// ---------------------------------------------------------------------------
// Step 2: Show the current Git status (read-only).
// ---------------------------------------------------------------------------
async function showGitStatus(repoRoot) {
  const branch = await git(["rev-parse", "--abbrev-ref", "HEAD"], repoRoot);
  if (branch.ok) {
    console.log(`\nCurrent branch: ${branch.stdout.trim()}`);
  }

  const status = await git(["status"], repoRoot);
  if (!status.ok) {
    console.error("ERROR: 'git status' failed.");
    if (status.stderr) console.error(`Git said: ${status.stderr}`);
    return null;
  }

  console.log("\n=== Git status ===");
  console.log(status.stdout.trimEnd());
  return status.stdout;
}

// ---------------------------------------------------------------------------
// Step 3: Show the diff for documentation changes (read-only).
// ---------------------------------------------------------------------------
async function showDocDiff(repoRoot, docFiles) {
  console.log("\n=== Diff for documentation changes ===");

  // Unstaged worktree diff first.
  const unstaged = await git(["diff", "--", ...docFiles], repoRoot);
  if (unstaged.ok && unstaged.stdout.trim()) {
    console.log(unstaged.stdout.trimEnd());
  } else if (!unstaged.ok) {
    console.error("ERROR: 'git diff' failed.");
    if (unstaged.stderr) console.error(`Git said: ${unstaged.stderr}`);
    return false;
  }

  // Then anything already staged, so the human sees the full picture.
  const staged = await git(["diff", "--cached", "--", ...docFiles], repoRoot);
  if (staged.ok && staged.stdout.trim()) {
    console.log("--- (staged changes) ---");
    console.log(staged.stdout.trimEnd());
  }

  // Untracked doc files have no diff output — list them explicitly.
  const status = await git(["status", "--porcelain"], repoRoot);
  if (status.ok) {
    const untrackedDocs = parsePorcelainPaths(status.stdout).filter((f) =>
      docFiles.includes(f)
    );
    const missing = untrackedDocs.filter(
      (f) => !unstaged.stdout.includes(f) && !staged.stdout.includes(f)
    );
    if (missing.length > 0) {
      console.log("(untracked documentation files — no diff available):");
      for (const f of missing) console.log(`  ?? ${f}`);
    }
  }

  if (!unstaged.stdout.trim() && !staged.stdout.trim()) {
    console.log("(no unstaged or staged documentation changes detected)");
  }

  return true;
}

// ---------------------------------------------------------------------------
// Steps 4–5: Ask for explicit confirmation, then stage and commit ONLY if the
// human says yes. On rejection: nothing is staged and nothing is committed.
// ---------------------------------------------------------------------------
async function confirmStageAndCommit(repoRoot, docFiles, commitMessage) {
  // Safety check: refuse to stage files that do not exist on disk.
  for (const file of docFiles) {
    const abs = path.isAbsolute(file) ? file : path.join(repoRoot, file);
    if (!fs.existsSync(abs)) {
      console.error(`\nERROR: Documentation file does not exist: ${file}`);
      console.error("Nothing was staged and no commit was created.");
      return { committed: false, reason: "missing_file" };
    }
  }

  // Requirement 4: the exact confirmation prompt, before anything is staged.
  const approved = await askForConfirmation(CONFIRM_PROMPT);

  if (!approved) {
    // Requirement 7: reject → no staging, no commit.
    console.log("\n✗ Commit cancelled. Nothing was staged and nothing was committed.");
    return { committed: false, reason: "user_rejected" };
  }

  console.log("\nStaging documentation files...");
  const add = await git(["add", "--", ...docFiles], repoRoot);
  if (!add.ok) {
    console.error("ERROR: 'git add' failed. Nothing was committed.");
    if (add.stderr) console.error(`Git said: ${add.stderr}`);
    return { committed: false, reason: "add_failed" };
  }
  console.log(`✓ Staged: ${docFiles.join(", ")}`);

  console.log("Creating commit...");
  const commit = await git(["commit", "-m", commitMessage], repoRoot);
  if (!commit.ok) {
    console.error("ERROR: 'git commit' failed.");
    if (commit.stderr) console.error(`Git said: ${commit.stderr}`);
    console.error("The files remain staged; you can commit them manually or unstage with 'git restore --staged'.");
    return { committed: false, reason: "commit_failed" };
  }

  console.log("✓ Commit created:");
  console.log(commit.stdout.trimEnd());
  return { committed: true, reason: "ok" };
}

// ---------------------------------------------------------------------------
// Orchestration: the full post-fix Git flow.
// Returns { committed: boolean } so callers can chain Components together.
// ---------------------------------------------------------------------------
async function runGitIntegration(options) {
  const docFiles = Array.isArray(options.docFiles)
    ? options.docFiles
    : [options.docFiles].filter(Boolean);
  const commitMessage = sanitizeCommitMessage(options.commitMessage);

  if (docFiles.length === 0) {
    console.error("ERROR: No documentation files were provided. Nothing to do.");
    return { committed: false };
  }

  console.log("=== Git Integration (Component 7) ===\n");

  // 1. Repository check
  const repoRoot = await assertInsideGitRepository();
  if (!repoRoot) return { committed: false };

  // 2. Status
  const status = await showGitStatus(repoRoot);
  if (status === null) return { committed: false };

  // 3. Diff
  const diffOk = await showDocDiff(repoRoot, docFiles);
  if (!diffOk) return { committed: false };

  // 4–5. Confirm, then stage + commit (or reject cleanly)
  const result = await confirmStageAndCommit(repoRoot, docFiles, commitMessage);

  console.log("\n=== Summary ===");
  console.log(`Files:      ${docFiles.join(", ")}`);
  console.log(`Message:    "${commitMessage}"`);
  console.log(`Committed:  ${result.committed ? "yes" : "no"} (${result.reason})`);
  console.log("Push:       never (this script does not push)");
  console.log("PR:         never (this script does not create pull requests)");

  return result;
}

// ---------------------------------------------------------------------------
// Built-in test using docs/authentication.md (requirement 15).
// ---------------------------------------------------------------------------
async function builtInTest() {
  const docFile = "docs/authentication.md";

  console.log("=== Built-in test (docs/authentication.md) ===\n");

  // Sanity check that the built-in test target exists.
  if (readFileSafe(docFile) === null) {
    console.error(`ERROR: Built-in test target not found: ${docFile}`);
    console.error("Run this script from the repository root, or apply a fix with apply-fix.js first.");
    process.exit(1);
  }
  console.log(`✓ Documentation file exists: ${docFile}\n`);

  return runGitIntegration({
    docFiles: [docFile],
    commitMessage: DEFAULT_COMMIT_MESSAGE,
  });
}

// ---------------------------------------------------------------------------
// Entry point.
//   node git-integration.js                          → built-in test (docs/authentication.md)
//   node git-integration.js "message" [file ...]     → custom message and files
// ---------------------------------------------------------------------------
async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    await builtInTest();
    return;
  }

  if (args.includes("--help") || args.includes("-h")) {
    console.log("Usage: node git-integration.js [commit message] [documentation file ...]");
    console.log("");
    console.log("With no arguments, runs a built-in test using docs/authentication.md.");
    console.log("");
    console.log("Examples:");
    console.log('  node git-integration.js');
    console.log('  node git-integration.js "Update login docs" docs/authentication.md');
    console.log("");
    console.log("Safety: never pushes, never creates PRs, never uses destructive git commands.");
    return;
  }

  // First argument = commit message; remaining arguments = files to stage.
  // With no files given, default to the built-in target.
  const message = args[0];
  const files = args.slice(1).length > 0 ? args.slice(1) : ["docs/authentication.md"];

  await runGitIntegration({ docFiles: files, commitMessage: message });
}

main().catch((error) => {
  console.error(`Unexpected error: ${error && error.message ? error.message : error}`);
  process.exit(1);
});
