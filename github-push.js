#!/usr/bin/env node
// github-push.js — Component 8: Safe Git Push
// Safely pushes an existing local Git commit to the configured remote
// repository. Everything here is read-only until the human explicitly
// confirms; only a plain `git push` is ever executed.
//
// Hard safety rules enforced by this script:
//   - NEVER force-pushes (no --force, -f, or --force-with-lease).
//   - NEVER resets, checkouts, rebases, or uses any destructive git command.
//   - NEVER creates a GitHub Pull Request.
//   - NEVER modifies documentation files.
//   - NEVER calls the Groq API or any external service.
//   - Pushes ONLY after the human explicitly confirms with "y" or "yes".
//   - Node.js built-in modules only — zero external dependencies.
//   - Never exposes or requests API keys or credentials (git handles auth).

const { execFile } = require("child_process");

// The exact confirmation prompt required by the spec (requirement 7).
const CONFIRM_PROMPT = "Push this commit to GitHub? (y/n): ";

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
 * Redact any userinfo embedded in a remote URL before printing, e.g.
 * "https://user:token@github.com/..." → "https://***@github.com/...".
 * Credentials must never be exposed (requirement 17).
 */
function redactUrl(url) {
  const match = String(url).match(/^([a-z][a-z0-9+.-]*:\/\/)([^@/]+)@(.*)$/i);
  if (match) return `${match[1]}***@${match[3]}`;
  return String(url);
}

// ---------------------------------------------------------------------------
// Step 1: Verify the current directory is inside a Git repository.
//         Records the repo root so all later commands run from there.
// ---------------------------------------------------------------------------
async function assertInsideGitRepository() {
  const root = await git(["rev-parse", "--show-toplevel"]);

  if (!root.ok) {
    console.error("ERROR: This directory is not inside a Git repository.");
    console.error("");
    if (root.stderr) {
      console.error(`Git said: ${root.stderr}`);
    }
    console.error("Run this script from a directory inside your repository.");
    return null;
  }

  const toplevel = root.stdout.trim();
  console.log(`✓ Inside a Git repository: ${toplevel}`);
  return toplevel;
}

// ---------------------------------------------------------------------------
// Step 2: Determine the current branch (requirement 2).
//         Refuses to run in detached HEAD state — nothing to push then.
// ---------------------------------------------------------------------------
async function getCurrentBranch(repoRoot) {
  const ref = await git(["symbolic-ref", "--short", "-q", "HEAD"], repoRoot);

  if (!ref.ok || !ref.stdout.trim()) {
    console.error("ERROR: You are in detached HEAD state — there is no branch to push.");
    return null;
  }

  const branch = ref.stdout.trim();
  console.log(`✓ Current branch: ${branch}`);
  return branch;
}

// ---------------------------------------------------------------------------
// Step 3: Check the configured Git remote(s) (requirement 3).
//         Prefers "origin", otherwise uses the first configured remote.
// ---------------------------------------------------------------------------
async function getRemotes(repoRoot) {
  const remotes = await git(["remote"], repoRoot);

  if (!remotes.ok) {
    console.error("ERROR: Could not list the configured Git remotes.");
    if (remotes.stderr) console.error(`Git said: ${remotes.stderr}`);
    return null;
  }

  const list = remotes.stdout.split("\n").map((s) => s.trim()).filter(Boolean);

  if (list.length === 0) {
    console.error("ERROR: No Git remote is configured for this repository.");
    console.error("There is nowhere to push. Nothing was pushed.");
    return null;
  }

  console.log(`✓ Configured remote(s): ${list.join(", ")}`);

  const primary = list.includes("origin") ? "origin" : list[0];
  const url = await git(["remote", "get-url", primary], repoRoot);
  const display = url.ok ? redactUrl(url.stdout.trim()) : "(unknown)";
  console.log(`✓ Using remote: ${primary} (${display})`);

  return { list, primary, url: url.ok ? url.stdout.trim() : null };
}

// ---------------------------------------------------------------------------
// Step 4: Resolve what "the remote" means for this branch — the configured
//         upstream first, else the remote-tracking branch of the primary
//         remote. Returns null if neither exists (nothing to compare).
// ---------------------------------------------------------------------------
async function resolveCompareTarget(repoRoot, branchName, remotes) {
  // Prefer the branch's configured upstream, e.g. "origin/master".
  const upstream = await git(
    ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"],
    repoRoot
  );

  if (upstream.ok && upstream.stdout.trim()) {
    const name = upstream.stdout.trim();
    console.log(`✓ Upstream: ${name}`);
    return { compareRef: "@{upstream}", displayName: name, hasUpstream: true };
  }

  // Fall back to the remote-tracking branch of the primary remote.
  const tracking = `refs/remotes/${remotes.primary}/${branchName}`;
  const verify = await git(["rev-parse", "--verify", "--quiet", tracking], repoRoot);

  if (verify.ok) {
    const name = `${remotes.primary}/${branchName}`;
    console.log(`✓ Remote-tracking branch: ${name} (no upstream configured)`);
    return { compareRef: tracking, displayName: name, hasUpstream: false };
  }

  console.error(`ERROR: Branch "${branchName}" has no upstream and no remote-tracking branch (${remotes.primary}/${branchName}).`);
  console.error("Nothing to compare against. Set an upstream once, e.g.:");
  console.error(`  git push -u ${remotes.primary} ${branchName}`);
  return null;
}

// ---------------------------------------------------------------------------
// Step 5: Detect how far the branch is ahead of / behind its remote
//         (requirement 4). Ahead > 0 means there are commits to push.
// ---------------------------------------------------------------------------
async function getAheadBehind(repoRoot, compareRef) {
  const count = await git(["rev-list", "--left-right", "--count", `HEAD...${compareRef}`], repoRoot);

  if (!count.ok) {
    console.error("ERROR: Could not compare this branch with the remote.");
    if (count.stderr) console.error(`Git said: ${count.stderr}`);
    return null;
  }

  const parts = count.stdout.trim().split(/\s+/).map(Number);
  return { ahead: parts[0] || 0, behind: parts[1] || 0 };
}

// ---------------------------------------------------------------------------
// Step 6: List the commits that would be pushed (requirement 5).
// ---------------------------------------------------------------------------
async function getCommitsToPush(repoRoot, compareRef) {
  const log = await git(["log", "--oneline", `${compareRef}..HEAD`], repoRoot);
  if (!log.ok) return [];
  return log.stdout.split("\n").map((s) => s.trim()).filter(Boolean);
}

// ---------------------------------------------------------------------------
// Orchestration: the full safe push flow.
// Returns { pushed, reason } so callers can chain Components together.
// ---------------------------------------------------------------------------
async function runPush() {
  console.log("=== Safe Git Push (Component 8) ===\n");

  // 1. Repository check
  const repoRoot = await assertInsideGitRepository();
  if (!repoRoot) return finish({ pushed: false, reason: "not_a_repository" });

  // 2. Current branch
  const branchName = await getCurrentBranch(repoRoot);
  if (!branchName) return finish({ pushed: false, reason: "detached_head" });

  // 3. Remote check
  const remotes = await getRemotes(repoRoot);
  if (!remotes) return finish({ pushed: false, reason: "no_remote" });

  // 4. Comparison target (upstream, else remote-tracking branch)
  const target = await resolveCompareTarget(repoRoot, branchName, remotes);
  if (!target) return finish({ pushed: false, reason: "no_upstream" });

  // 5. Ahead / behind detection
  const ab = await getAheadBehind(repoRoot, target.compareRef);
  if (!ab) return finish({ pushed: false, reason: "compare_failed" });

  console.log(
    `\nBranch "${branchName}" is ${ab.ahead} commit(s) ahead and ${ab.behind} commit(s) behind ${target.displayName}.`
  );

  // 6. Nothing to push → report and exit without doing anything (requirement 6).
  if (ab.ahead === 0) {
    if (ab.behind === 0) {
      console.log("\n✓ Nothing to push: the branch is up to date with the remote.");
    } else {
      console.log(`\nNothing to push: the remote has ${ab.behind} commit(s) not present locally.`);
      console.log("Fetch or pull to sync first (this script never fetches or pulls).");
    }
    return finish({ pushed: false, reason: "nothing_to_push" });
  }

  // Diverged branches — pushing would be non-fast-forward and need force.
  if (ab.behind > 0) {
    console.error("\nERROR: The branch has diverged from the remote (local commits AND remote commits).");
    console.error("Pushing would be a non-fast-forward update and would require --force.");
    console.error("This script NEVER force-pushes. Nothing was pushed.");
    return finish({ pushed: false, reason: "diverged" });
  }

  // 7. Show the branch and the commits that will be pushed (requirement 5).
  const commits = await getCommitsToPush(repoRoot, target.compareRef);
  console.log(`\n=== Commits that will be pushed (${commits.length}) ===`);
  for (const line of commits) console.log(`  ${line}`);
  console.log(`\nTarget: ${branchName} → ${target.displayName}`);
  console.log("Note: this comparison uses your local copy of the remote branch (last fetched state).");

  // 8. Explicit confirmation — only "y" or "yes" proceeds (requirements 7–9).
  const approved = await askForConfirmation(CONFIRM_PROMPT);

  if (!approved) {
    console.log("\n✗ Push cancelled. Nothing was pushed.");
    return finish({ pushed: false, reason: "user_rejected" });
  }

  // 9. Push. Plain `git push` to the configured upstream, or an explicit
  //    non-force push to the primary remote. Never any force flags.
  const pushArgs = target.hasUpstream ? ["push"] : ["push", remotes.primary, branchName];
  console.log(`\nPushing to ${target.displayName}...`);
  const push = await git(pushArgs, repoRoot);

  if (!push.ok) {
    console.error("\nERROR: 'git push' failed. Nothing was pushed.");
    if (push.stdout.trim()) console.log(push.stdout.trimEnd());
    if (push.stderr) console.error(`Git said: ${push.stderr}`);
    return finish({ pushed: false, reason: "push_failed" });
  }

  console.log("✓ Push succeeded:");
  // git push writes its progress/detail to stderr; show it when present.
  const pushOut = push.stdout.trim();
  const pushErr = push.stderr.trim();
  if (pushOut) console.log(pushOut);
  if (pushErr) console.log(pushErr);
  return finish({ pushed: true, reason: "ok" });
}

/** Print the closing summary for any outcome. */
function finish(result) {
  console.log("\n=== Summary ===");
  console.log(`Pushed:  ${result.pushed ? "yes" : "no"} (${result.reason})`);
  console.log("Force:   never");
  console.log("PR:      never");
  return result;
}

// ---------------------------------------------------------------------------
// Entry point (requirement 18): the built-in test uses the current repository
// and current branch. No arguments accepted beyond --help.
// ---------------------------------------------------------------------------
async function main() {
  const args = process.argv.slice(2);

  if (args.includes("--help") || args.includes("-h")) {
    console.log("Usage: node github-push.js");
    console.log("");
    console.log("With no arguments, runs the built-in test: the full safe push");
    console.log("flow on the current repository and current branch.");
    console.log("");
    console.log("Safety: never force-pushes, never creates PRs, never uses");
    console.log("destructive git commands, never modifies documentation files,");
    console.log("never calls external APIs, never handles credentials.");
    return;
  }

  if (args.length > 0) {
    console.error("ERROR: This script takes no arguments (other than --help).");
    console.error("It always operates on the current repository and current branch.");
    process.exit(1);
  }

  console.log("=== Built-in test: current repository and current branch ===\n");
  const result = await runPush();

  // Clean outcomes exit 0; genuine problems exit 1.
  const cleanReasons = ["ok", "nothing_to_push", "user_rejected"];
  if (!cleanReasons.includes(result.reason)) {
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(`Unexpected error: ${error && error.message ? error.message : error}`);
  process.exit(1);
});