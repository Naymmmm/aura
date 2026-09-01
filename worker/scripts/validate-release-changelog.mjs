import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const links = [
  '[Windows Download](https://api.copal.run/dl/latest)',
  '[macOS Download](https://api.copal.run/dl/latest-macos)',
  '[Source Download](https://api.copal.run/dl/source)',
];

export function validateReleaseChangelog(raw, tag) {
  const errors = [];
  const version = /^v(\d+)\.(\d+)\.(\d+)$/.exec(tag);
  if (!version) return [`tag must use vMAJOR.MINOR.PATCH, received ${tag}`];
  const text = raw.replaceAll('\r\n', '\n').trim();
  const expectedHeading = `# v${version[1]}.${version[2]}${version[3]}`;
  if (text.split('\n', 1)[0] !== expectedHeading) errors.push(`first line must be ${expectedHeading}`);
  if (!text.includes('```diff\n')) errors.push('missing diff changelog block');
  if (!/^\+ .+:$/m.test(text)) errors.push('add at least one "+ Category:" line');
  if (!/^- .+/m.test(text)) errors.push('add at least one "- detail" line');
  for (const link of links) if (!text.includes(link)) errors.push(`missing ${link}`);
  if (!text.endsWith('<@&1544233739322789948>')) errors.push('changelog must end with the Aura Customers role mention');
  if (text.length > 2000) errors.push(`Discord message is ${text.length} characters; maximum is 2000`);
  return errors;
}

async function main() {
  const [file, tag] = process.argv.slice(2);
  if (!file || !tag) throw new Error('usage: validate-release-changelog.mjs <file> <tag>');
  const text = await readFile(file, 'utf8');
  const errors = validateReleaseChangelog(text, tag);
  if (errors.length) throw new Error(errors.join('\n'));
  console.log(`Validated ${file} for ${tag}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
