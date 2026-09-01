import { describe, expect, it } from 'vitest';
import workflow from '../../.github/workflows/build.yml?raw';
import backfillWorkflow from '../../.github/workflows/backfill-release-archive.yml?raw';

describe('release workflow', () => {
  it('builds tracked source and publishes every artifact to the version archive', () => {
    expect(workflow).toContain('git archive');
    expect(workflow).toContain('aura-source.zip');
    expect(workflow).toContain('/v1/releases/publish');
    expect(workflow).toContain('secrets.AURA_RELEASE_UPLOAD_TOKEN');
    expect(workflow).toContain('publish windows');
    expect(workflow).toContain('publish macos');
    expect(workflow).toContain('publish source');
    expect(workflow).toContain('sha256sum');
    expect(workflow).toContain('-F "sha256=');
  });

  it('requires a versioned changelog and publishes it after all artifacts', () => {
    expect(workflow).toContain('releases/${GITHUB_REF_NAME}.md');
    expect(workflow).toContain('validate-release-changelog.mjs');
    expect(workflow).toContain('/v1/releases/announce');
    expect(workflow).toContain('body_path: releases/${{ github.ref_name }}.md');
  });

  it('backfills every historical binary and generated source without leaving an old release as latest', () => {
    for (const tag of [
      'v0.1.0', 'v0.2.0', 'v0.2.1', 'v0.2.2', 'v0.2.3',
      'v0.2.4', 'v0.2.5', 'v0.2.6', 'v0.3.0', 'v0.3.1',
    ]) {
      expect(backfillWorkflow).toContain(tag);
    }
    expect(backfillWorkflow).toContain('gh release download');
    expect(backfillWorkflow).toContain('git archive');
    expect(backfillWorkflow).toContain('/v1/releases/publish');
    expect(backfillWorkflow).toContain('secrets.AURA_RELEASE_UPLOAD_TOKEN');
    expect(backfillWorkflow).toContain('Upload v0.3.1 last');
    expect(backfillWorkflow).toContain('sha256sum');
    expect(backfillWorkflow).toContain('-F "sha256=');
  });
});
