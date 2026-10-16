import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SKILLS = path.join(ROOT, 'plugin', 'skills');

test('every slash command has a skill whose name matches its folder and that uses the launcher', () => {
  const want = ['init', 'build', 'deploy', 'server', 'rollback', 'logs', 'setup', 'doctor', 'status', 'usage', 'login'];
  for (const name of want) {
    const text = fs.readFileSync(path.join(SKILLS, name, 'SKILL.md'), 'utf8');
    const front = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    assert.ok(front, `${name}: frontmatter`);
    assert.match(front[1], new RegExp(`^name: ${name}$`, 'm'));
    assert.match(front[1], /^description: .+/m);
    assert.ok(text.includes('${CLAUDE_PLUGIN_ROOT}/scripts/run.js'), `${name}: uses the launcher`);
  }
});

test('the launcher runs the CLI and passes its exit code through', () => {
  const res = spawnSync(process.execPath, [path.join(ROOT, 'plugin', 'scripts', 'run.js'), '--version'], {
    encoding: 'utf8',
    env: { ...process.env, CLAUDE_PLUGIN_ROOT: path.join(ROOT, 'plugin') },
  });
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout.trim(), /^\d+\.\d+\.\d+/);
});
