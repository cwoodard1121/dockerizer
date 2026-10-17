import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { configDir, homeSearch, resolveConfig, userHome } from '../src/config.js';
import { getOfflineStatus } from '../src/status.js';
import { tempTree } from './helpers.js';

const withConfig = (project = 'demo-proj') => tempTree({ '.dockeriser/config.json': JSON.stringify({ project }) });

test('the home folder: the env home when it has the config, else the real profile', () => {
  const account = tempTree({ 'x.txt': '' }); // a Claude account dir: USERPROFILE points here
  const real = withConfig();
  assert.equal(userHome({ env: {}, osHome: account, realHome: real }), real);
  assert.equal(userHome({ env: {}, osHome: real, realHome: account }), real);
  const both = withConfig('other-proj');
  assert.equal(userHome({ env: {}, osHome: both, realHome: real }), both, 'a configured override home wins');
  // Nothing configured anywhere: writes go to the real profile, so every account converges.
  assert.equal(userHome({ env: {}, osHome: account, realHome: tempTree({}) }) !== account, true);
  assert.equal(userHome({ env: {}, osHome: account, realHome: null }), account, 'no real profile known: the env home');
});

test('DOCKERISER_CONFIG_DIR names the config folder itself', () => {
  const dir = tempTree({ 'config.json': JSON.stringify({ project: 'demo-proj' }) });
  assert.equal(configDir('/somewhere', { DOCKERISER_CONFIG_DIR: dir }), path.resolve(dir));
  assert.equal(configDir('/home/u', {}), path.join('/home/u', '.dockeriser'));
  const cfg = resolveConfig({ env: { DOCKERISER_CONFIG_DIR: dir }, homeDir: tempTree({}) });
  assert.equal(cfg.project, 'demo-proj');
});

test('a missing project error names every folder that was searched', () => {
  const account = tempTree({});
  const real = tempTree({});
  const searched = homeSearch({ env: {}, osHome: account, realHome: real });
  assert.deepEqual(searched, [path.join(account, '.dockeriser', 'config.json'), path.join(real, '.dockeriser', 'config.json')]);
  assert.deepEqual(homeSearch({ env: { DOCKERISER_CONFIG_DIR: real }, osHome: account, realHome: real }), [path.join(path.resolve(real), 'config.json')]);
  assert.throws(
    () => resolveConfig({ env: {}, homeDir: account, searched }),
    (err) => err.fix.includes(searched[0]) && err.fix.includes(searched[1]),
  );
});

test('status reports the home folder and the searched paths', () => {
  const home = tempTree({});
  const s = getOfflineStatus({ env: {}, homeDir: home, searched: ['a', 'b'] });
  assert.equal(s.home, home);
  assert.deepEqual(s.searched, ['a', 'b']);
  assert.equal(s.configured, false);
  assert.ok(fs.existsSync(home));
});
