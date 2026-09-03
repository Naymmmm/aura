import { useEffect, useState } from 'react';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { fetchArchive, type ArchiveResponse, type ArchiveVersion, type ArtifactType } from '@/lib/api';

function artifactLabel(artifact: ArtifactType): string {
  return artifact === 'windows' ? 'Windows' : artifact === 'macos' ? 'macOS' : 'Source';
}

function ArtifactLinks({ version, canDownloadSource }: { version: ArchiveVersion; canDownloadSource: boolean }) {
  const artifacts = (['windows', 'macos', 'source'] as ArtifactType[])
    .filter((artifact) => artifact !== 'source' || canDownloadSource)
    .filter((artifact) => version.artifacts[artifact]);

  if (artifacts.length === 0) return <Badge variant="outline">none</Badge>;

  return (
    <div className="flex flex-wrap gap-2 justify-end max-sm:justify-start">
      {artifacts.map((artifact) => {
        const key = version.artifacts[artifact]!.key;
        const ext = key.endsWith('.dmg') ? 'dmg' : 'zip';
        return (
          <Button key={artifact} variant="outline" size="sm" asChild>
            <a href={`/dl/archive/${version.version}/${artifact}.${ext}`}>{artifactLabel(artifact)}</a>
          </Button>
        );
      })}
    </div>
  );
}

function VersionCard({
  version,
  canDownloadSource,
  latest,
  dev,
}: {
  version: ArchiveVersion;
  canDownloadSource: boolean;
  latest?: boolean;
  dev?: boolean;
}) {
  const date = new Date(version.uploaded).toISOString().slice(0, 10);
  return (
    <div className="flex items-center justify-between gap-4 py-4 border-t first:border-t-0 max-sm:flex-col max-sm:items-start">
      <div className="min-w-0">
        <div className="flex items-center gap-2 font-semibold">
          <span className="truncate">{version.version}</span>
          {latest ? (
            <Badge>latest</Badge>
          ) : dev ? (
            <Badge variant="dev">dev</Badge>
          ) : null}
        </div>
        <div className="text-sm text-muted-foreground">{date}</div>
      </div>
      <ArtifactLinks version={version} canDownloadSource={canDownloadSource} />
    </div>
  );
}

function Channel({
  title,
  versions,
  canDownloadSource,
  dev,
}: {
  title: string;
  versions: ArchiveVersion[];
  canDownloadSource: boolean;
  dev?: boolean;
}) {
  if (versions.length === 0) {
    return <div className="text-muted-foreground text-sm py-8">{title} builds have not been published yet.</div>;
  }
  const [latest, ...older] = versions;
  return (
    <div className="mt-6">
      <div className="uppercase tracking-wide text-xs font-medium text-muted-foreground">Latest {title}</div>
      <Card className="mt-2">
        <CardContent className="p-5">
          <VersionCard version={latest} canDownloadSource={canDownloadSource} latest={!dev} />
        </CardContent>
      </Card>
      {older.length > 0 && (
        <>
          <div className="uppercase tracking-wide text-xs font-medium text-muted-foreground mt-6">Older builds</div>
          <div className="mt-1">
            {older.map((version) => (
              <VersionCard key={version.version} version={version} canDownloadSource={canDownloadSource} dev={dev} />
            ))}
          </div>
        </>
      )}
    </div>
  );
}

export default function VersionArchive() {
  const [data, setData] = useState<ArchiveResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchArchive().then(setData).catch((err) => setError(String(err)));
  }, []);

  if (error) {
    return (
      <div className="mx-auto max-w-3xl px-4 pt-16">
        <Card>
          <CardHeader>
            <CardTitle>Could not load the version archive</CardTitle>
            <CardDescription>{error}</CardDescription>
          </CardHeader>
        </Card>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="mx-auto max-w-3xl px-4 pt-16">
        <div className="h-8 w-44 animate-pulse rounded bg-muted" />
        <div className="mt-28 h-32 animate-pulse rounded-xl border bg-card" />
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-3xl px-4 pb-24 pt-16">
      <header>
        <h1 className="text-3xl sm:text-4xl font-bold tracking-tight">Version Archive</h1>
        <p className="mt-2 text-muted-foreground">
          Current and archived builds for authorized Aura Discord members.
        </p>
      </header>

      <Tabs defaultValue="stable" className="mt-8">
        <TabsList>
          <TabsTrigger value="stable">Stable</TabsTrigger>
          <TabsTrigger value="dev">Dev</TabsTrigger>
        </TabsList>
        <TabsContent value="stable">
          <Channel title="Stable" versions={data.stable} canDownloadSource={data.canDownloadSource} />
        </TabsContent>
        <TabsContent value="dev">
          <Channel title="Dev / branch" versions={data.dev} canDownloadSource={data.canDownloadSource} dev />
        </TabsContent>
      </Tabs>
    </div>
  );
}
