import { describe, expect, it } from 'vitest';
import { validateReleaseChangelog } from '../scripts/validate-release-changelog.mjs';

const releaseLinks = `
[Windows Download](https://api.copal.run/dl/latest)
[macOS Download](https://api.copal.run/dl/latest-macos)
[Source Download](https://api.copal.run/dl/source)

<@&1544233739322789948>`;

describe('release changelog validation', () => {
  it('accepts a dotted year.minor.hotfix heading', () => {
    const changelog = `# v26.0.1
\`\`\`diff
+ Release:
- ships the hotfix
\`\`\`${releaseLinks}`;

    expect(validateReleaseChangelog(changelog, 'v26.0.1')).toEqual([]);
  });
});
