export type ArtifactType =
  | 'windows'
  | 'windows-arm64'
  | 'windows-setup'
  | 'windows-arm64-setup'
  | 'macos'
  | 'linux'
  | 'source';

export interface ArchiveArtifact {
  key: string;
  size: number;
  sha256: string;
  uploaded: number;
}

export interface ArchiveVersion {
  version: string;
  uploaded: number;
  artifacts: Partial<Record<ArtifactType, ArchiveArtifact>>;
}

export interface ArchiveResponse {
  entitled: boolean;
  canDownloadSource: boolean;
  stable: ArchiveVersion[];
  dev: ArchiveVersion[];
}

export async function fetchArchive(): Promise<ArchiveResponse> {
  const response = await fetch('/v1/archive', {
    headers: { accept: 'application/json' },
  });
  if (response.status === 401) {
    // Session expired between the page load and this request.
    window.location.href = '/auth/discord/login?return_to=%2Farchive';
    throw new Error('unauthorized');
  }
  if (!response.ok) {
    throw new Error(`archive request failed (${response.status})`);
  }
  return (await response.json()) as ArchiveResponse;
}

export function extensionFor(key: string): string {
  return key.endsWith('.dmg') ? 'dmg' : 'zip';
}
