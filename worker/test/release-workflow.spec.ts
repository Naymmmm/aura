import { describe, expect, it } from 'vitest';
import workflow from '../../.github/workflows/build.yml?raw';
import backfillWorkflow from '../../.github/workflows/backfill-release-archive.yml?raw';
import windowsBuild from '../../app/windows/CMakeLists.txt?raw';
import newServers from '../../infra/03-NewServers.ps1?raw';
import remakeServers from '../../infra/03b-Remake.ps1?raw';
import serverUserData from '../../infra/user-data.yaml?raw';
import udpServerMigration from '../../infra/07-EnableUdpOverTcp.ps1?raw';
import publishRelease from '../../.github/workflows/publish-release.yml?raw';
import devBuild from '../../.github/workflows/dev-build.yml?raw';

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

  it('ships macOS as a universal DMG instead of a zip', () => {
    expect(workflow).toContain('--target universal-apple-darwin --bundles dmg');
    expect(workflow).toContain('publish macos dist/aura-macos-universal/aura-macos-universal.dmg');
    expect(workflow).not.toContain('ditto -c -k --keepParent');
  });

  it('builds the Rust aura-core into every desktop bundle', () => {
    expect(workflow).toContain('--manifest-path aura-core-rs/Cargo.toml');
    expect(workflow).not.toMatch(/(^|\s)go build/m);
    expect(workflow).toContain('publish windows-arm64');
    expect(workflow).toContain('publish linux');
  });

  it('only promotes and announces tagged releases', () => {
    expect(workflow).toContain('-F "promote=${PROMOTE}"');
    expect(workflow).toContain("if: startsWith(github.ref, 'refs/tags/v')");
  });

  it('bundles Aura Core during every normal Windows app build', () => {
    expect(windowsBuild).toContain('tool/fetch_naive.ps1');
    expect(windowsBuild).toContain('COMPONENT Runtime');
    expect(windowsBuild).toContain('Aura Core bundle failed');
  });

  it('keeps replacement proxy servers IPv6-capable', () => {
    expect(newServers).toMatch(/"--assign-ipv6-ip",\s+"true"/);
    expect(remakeServers).toMatch(/"--assign-ipv6-ip",\s+"true"/);
    expect(serverUserData).toContain('dhcp6: true');
    expect(serverUserData).toContain('accept-ra: true');
    expect(udpServerMigration).toContain('--network host');
    expect(udpServerMigration).toContain('$Command.Replace("`r", "")');
    expect(udpServerMigration).toContain('listen = "0.0.0.0"');
    expect(udpServerMigration).toContain('iptables -C INPUT');
    expect(udpServerMigration).toContain('netfilter-persistent save');
    expect(udpServerMigration).toContain('SslStream');
    expect(udpServerMigration).not.toContain('--proxy $proxy');
  });

  it('can publish a release from artifacts built by an earlier workflow run', () => {
    expect(publishRelease).toContain('workflow_dispatch:');
    expect(publishRelease).toContain('source_run_id:');
    expect(publishRelease).toContain('run-id: ${{ inputs.source_run_id }}');
    expect(publishRelease).toContain('/v1/releases/announce');
  });

  it('publishes dev branch builds to the archive without promoting them', () => {
    expect(devBuild).toContain("branches: ['dev']");
    expect(devBuild).toContain('/v1/releases/publish');
    expect(devBuild).toContain('secrets.AURA_RELEASE_UPLOAD_TOKEN');
    expect(devBuild).toContain('promote=false');
    expect(devBuild).toContain('-dev.');
    expect(devBuild).toContain('dev-windows-amd64');
    expect(devBuild).toContain('dev-macos-arm64.dmg');
    expect(devBuild).not.toContain('/v1/releases/announce');
  });

  it('attaches dev builds to a prerelease on GitHub', () => {
    expect(devBuild).toContain('contents: write');
    expect(devBuild).toContain('GH_TOKEN: ${{ github.token }}');
    expect(devBuild).toContain('gh release create');
    expect(devBuild).toContain('--prerelease');
    expect(devBuild).toContain('--target "$GITHUB_SHA"');
    expect(devBuild).toContain('dist/dev-windows-amd64/dev-windows-amd64.zip');
    expect(devBuild).toContain('dist/dev-macos-arm64/dev-macos-arm64.dmg');
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
    expect(backfillWorkflow).toContain('-F "promote=${promote}"');
    expect(backfillWorkflow).toContain('upload_release "$version" false');
  });
});
