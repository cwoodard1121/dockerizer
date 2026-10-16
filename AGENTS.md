# dockeriser

Runs `docker build` on Google Cloud Build instead of this PC: packages a folder, submits it, streams the logs and pushes the image to Artifact Registry.
Used by Cameron and his AI agents (via the Claude Code plugin in `plugin/`: a skill, six `/dockeriser:*` slash commands and a SessionStart hook) so Docker builds stop eating local memory. Setup is one command (`setup/setup.ps1`, or `/dockeriser:setup`) that asks for the project.

<!-- change-workflow:start — managed by the change-workflow setup skill; edit the profile values freely, re-running setup keeps them -->
## Change workflow profile

Read by the `change-workflow` skill (any agent that is not Claude Code reads that skill's file and
follows it). Fill every field; `None` is a valid answer, a blank is not.

- **Read first:** `README.md` (commands, exit codes, `--json` schema), `docs/SETUP.md` (Google Cloud setup and roles), `docs/RESEARCH.md` (verified API/IAM/pricing facts), `bin/dockeriser.js` (CLI entry), `src/` (one module per stage: `config` → `package-source` → `upload` → `build` → `logs`, plus `usage`/`status`/`login`/`doctor`/`errors`/`output`), `plugin/` (skills in `plugin/skills/<name>/SKILL.md`, launcher `plugin/scripts/run.js`, hook `plugin/hooks/session-start.js`)
- **Surfaces:** CLI (`dockeriser`), Claude Code plugin (`plugin/`: the `dockeriser` skill, slash commands `/dockeriser:build|setup|doctor|status|usage|login`, SessionStart hook), Google Cloud setup scripts (`setup/`)
- **Interface checklist:** for a new or changed command, flag or JSON field: 1) `parseArgs` options in `bin/dockeriser.js` 2) `--help` text 3) README command reference / exit codes / `--json` schema 4) `plugin/skills/dockeriser/SKILL.md` if agents use it 5) tests in `test/`
- **Gates:** `npm test` always · `bash -n setup/setup.sh` and the PowerShell parser check of `setup/setup.ps1` when `setup/` changed · `node bin/dockeriser.js build examples/hello --image hello --project demo-proj --dry-run` when the build request changed · a real `node bin/dockeriser.js build examples/hello --image hello` when `src/build.js`, `src/logs.js` or `src/upload.js` changed and credentials are configured
- **Release kinds:** `Local` — agents run it from the clone at `C:/Users/camer/Desktop/Projects/dockeriser`; pull it · `Cloud setup` — re-run `setup/setup.ps1` (Google Cloud resources or permissions changed) · `None — docs, tests, tooling`
- **Specs / Plans:** `docs/specs` / `docs/plans`
- **After an issue change:** None (no board sync script)
- **Agent label:** `agent: cameron-claude`

## The change workflow: one path from "I want X changed" to the PR

Every change request, however small, runs it. The depth scales with the change; the steps do not.
The spec and the plan are committed on the branch and linked from the issue.

0. **Orient.** `DO NOW` issues first; the request's issue claimed; the read-first paths read; branch
   cut from the default branch.
1. **Questions, one at a time.** Each multiple choice, the recommended option first with one
   sentence on why: purpose, scope boundary, surface, data and interfaces, edge cases, the owner's
   success check. Skip what the request already answers; stop when no answer would change the design.
2. **Approaches.** Two or three with trade-offs and a recommendation; the owner picks one.
3. **Spec**, committed. No code until the owner approves it; a small change gets a short spec, not
   no spec. Owner away: `needs-decision` on the issue and move to another one.
4. **Plan**, committed and linked from the issue: the file structure, the interface checklist, and
   tasks that each carry their files, failing test, code, commands and commit — no placeholders.
5. **Execute** the tasks in order, test → code → commit → push each, without pausing for approval;
   stop only on a blocker and name it.
6. **Finish.** The gates with their real output, the PR from the template with `## Spec and plan`,
   `## Release`, `Closes #n`, `status: in-review`.
7. **Report** in the fixed shape: Done · PR and release kind · Spec and plan · Verified · Left out · Next.

## Issue tracking

Bugs and outstanding work live in GitHub Issues, not in a markdown file, a code comment or an
agent's memory. Every issue carries exactly one `priority: critical|high|medium|low` label and one
type label (`bug`, `enhancement`, `chore`, `documentation`); `needs-decision` when it is blocked on
the owner. `DO NOW` marks a problem found live: it sits on top of the priority label, never instead
of it, and goes before everything else. Exactly one `status:` label at a time.

Every agent does all of this, in order, for every issue it works. After each step, and after
opening, closing or relabeling any issue, run the profile's after-issue-change command.

0. **`DO NOW` first.** `gh issue list --label "DO NOW"` before picking anything up.
1. **Pick up.** Read it, check nobody else holds it, then
   `gh issue edit <n> --add-assignee @me --add-label "status: claimed" --add-label "<agent label>"`.
   Planned for after your current item instead: same command with `status: queued`.
2. **Start** — the moment you begin editing or testing:
   `gh issue edit <n> --remove-label "status: claimed" --remove-label "status: queued" --add-label "status: in-progress"`.
3. **Blocked on the owner:** `gh issue edit <n> --add-label needs-decision` and
   `gh issue comment <n> --body "Decision needed: <the exact question and the options>"`. Keep your
   `status:` label; remove `needs-decision` when the answer lands.
4. **PR opened:** `gh issue edit <n> --remove-label "status: in-progress" --add-label "status: in-review"`,
   with `Closes #<n>` in the PR body.
5. **Merged:** the `Closes #<n>` closes the issue. Never close one by hand unless it turned out
   done or obsolete, and then with a comment saying why.
6. **Handing back** (you stop without a PR): remove your assignee, your `status:` label and your
   agent label, and comment where you left it.

A bug or gap you find that you were not asked to fix gets an issue — labeled, assigned to you —
not a mention and not a bare code comment. Fixing it in the current work: `Closes #<n>` in the PR.
<!-- change-workflow:end -->
