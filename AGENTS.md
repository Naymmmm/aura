# Aura repository instructions

## Before changing or releasing

- Fetch the remote repository before starting and integrate the current `origin/master`; never release from a stale base.
- Preserve unrelated user changes and use `.worktrees/` for isolated feature work.
- Run the relevant Worker, Flutter and Aura Core checks before publishing.

## Release changelogs

Every release tag `vMAJOR.MINOR.PATCH` must include `releases/vMAJOR.MINOR.PATCH.md`. Write a useful user-facing changelog based on the actual diff and verified behavior; do not dump commit titles or invent changes.

Use Aura's compact public heading (`v0.3.1` becomes `# v0.31`) and this exact structure:

````text
# v0.31
```diff
+ Feature category:
- concise user-facing change
- another verified change
```

[Windows Download](https://api.copal.run/dl/latest)
[macOS Download](https://api.copal.run/dl/latest-macos)
[Source Download](https://api.copal.run/dl/source)

<@&1544233739322789948>
````

- Group related changes under clear `+ Category:` lines and use `- detail` lines beneath them.
- Mention concrete user impact, supported platforms, reliability changes and important migration behavior.
- Keep the entire file within Discord's 2,000-character message limit.
- End with the Aura Customers role mention; do not ping `@everyone`.
- The GitHub release body and Discord announcement must use the same file.
- Never tag until `node worker/scripts/validate-release-changelog.mjs releases/<tag>.md <tag>` succeeds.
