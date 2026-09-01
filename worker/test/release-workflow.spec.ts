import { describe, expect, it } from 'vitest';
import workflow from '../../.github/workflows/build.yml?raw';

describe('release workflow', () => {
  it('builds tracked source and publishes every artifact to the version archive', () => {
    expect(workflow).toContain('git archive');
    expect(workflow).toContain('aura-source.zip');
    expect(workflow).toContain('/v1/releases/publish');
    expect(workflow).toContain('secrets.AURA_RELEASE_UPLOAD_TOKEN');
    expect(workflow).toContain('publish windows');
    expect(workflow).toContain('publish macos');
    expect(workflow).toContain('publish source');
  });

  it('requires a versioned changelog and publishes it after all artifacts', () => {
    expect(workflow).toContain('releases/${GITHUB_REF_NAME}.md');
    expect(workflow).toContain('validate-release-changelog.mjs');
    expect(workflow).toContain('/v1/releases/announce');
    expect(workflow).toContain('body_path: releases/${{ github.ref_name }}.md');
  });
});
