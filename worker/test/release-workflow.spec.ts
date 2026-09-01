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
});
