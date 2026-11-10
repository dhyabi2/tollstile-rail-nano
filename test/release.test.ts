import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (p: string): string => readFileSync(new URL(p, import.meta.url), 'utf8');
const pkg = JSON.parse(read('../package.json')) as {
  version: string;
  files: string[];
  scripts: Record<string, string>;
  repository: { url: string };
};

describe('the release files tell the truth about this package', () => {
  it('the CHANGELOG has an entry for the version in package.json', () => {
    expect(read('../CHANGELOG.md')).toContain(`## ${pkg.version} `);
  });

  it('the repository field names an account that exists', () => {
    expect(pkg.repository.url).toContain('github.com/dhyabi2/tollstile-rail-nano');
    expect(pkg.repository.url).not.toMatch(/PANDeveloper001/i);
  });

  it('a clean checkout cannot publish an empty package: dist ships and something builds it', () => {
    expect(pkg.files).toContain('dist');
    expect(pkg.scripts.prepare ?? pkg.scripts.prepack).toBe('npm run build');
  });

  it('the review response lists all six requested changes and is honest that the test-network run is not done', () => {
    const doc = read('../docs/TOLLSTILE-49-RESPONSE.md');
    for (let n = 1; n <= 6; n += 1) expect(doc, `row ${n}`).toMatch(new RegExp(`^\\| ${n} \\|`, 'm'));
    expect(doc).toMatch(/\*\*NOT DONE\.\*\*/);
    // The README must not claim a test-network run the response says does not exist.
    expect(read('../README.md')).toMatch(/not yet run end to end on a Nano test network/);
  });

  it('nothing in the shipped docs points at the deleted account', () => {
    for (const f of ['../README.md', '../CHANGELOG.md', '../docs/TOLLSTILE-49-RESPONSE.md']) {
      expect(read(f).replace(/deleted account|does not exist/g, ''), f).not.toMatch(/github\.com\/PANDeveloper001/);
    }
  });
});
