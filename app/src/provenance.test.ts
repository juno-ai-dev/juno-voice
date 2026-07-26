import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('production data provenance', () => {
  it('does not import test fixtures from production modules', () => {
    const root = join(process.cwd(), 'src');
    const files = readdirSync(root).filter((name) => /\.(ts|tsx)$/.test(name) && !name.includes('.test.'));
    for (const file of files) expect(readFileSync(join(root, file), 'utf8'), file).not.toMatch(/from ['"].*test\/fixtures/);
  });
});
