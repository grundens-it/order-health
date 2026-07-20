// Unit coverage for the runtime-flag resolution (issue #97): the PURE env-fallback
// precedence (row present vs absent vs env default) and the stub-mode resolvers
// (no DB => env config default, so behaviour is unchanged). The DB write path is
// an integration concern proven by the docker migrate-on-boot + PUT smoke.
import assert from 'node:assert/strict';
import test from 'node:test';
import { config, hasDatabase } from '../config.js';
import {
  getArmState,
  parseBoolSetting,
  resolveFlag,
  resolveRemediationFlags,
} from './runtimeSettings.js';

test('parseBoolSetting reads true / 1 as true, everything else false', () => {
  assert.equal(parseBoolSetting('true'), true);
  assert.equal(parseBoolSetting('TRUE'), true);
  assert.equal(parseBoolSetting('1'), true);
  assert.equal(parseBoolSetting('false'), false);
  assert.equal(parseBoolSetting('0'), false);
  assert.equal(parseBoolSetting('off'), false);
});

// The env-fallback precedence, the heart of issue #97.
test('resolveFlag: a present row wins; an absent row falls back to the env default', () => {
  // row present -> the row value wins over the env default
  assert.equal(resolveFlag('true', false), true, 'row true overrides env false');
  assert.equal(resolveFlag('false', true), false, 'row false overrides env true');
  // row absent -> the env default stands
  assert.equal(resolveFlag(null, false), false, 'no row => env default false');
  assert.equal(resolveFlag(null, true), true, 'no row => env default true');
  assert.equal(resolveFlag(undefined, false), false, 'undefined row => env default false');
});

test('stub mode (no DATABASE_URL): resolvers return the env config, so posture is unchanged', async () => {
  assert.equal(hasDatabase(), false, 'these unit tests run without a database');
  const flags = await resolveRemediationFlags();
  assert.equal(flags.remediationLiveEnabled, config.remediation.liveEnabled);
  assert.equal(flags.killSwitch, config.remediation.killSwitch);
});

test('stub-mode arm state reports env_default sources and stays disarmed by default', async () => {
  const state = await getArmState();
  assert.equal(state.remediationLiveEnabled, config.remediation.liveEnabled);
  assert.equal(state.killSwitch, config.remediation.killSwitch);
  assert.equal(state.armed, config.remediation.liveEnabled && !config.remediation.killSwitch);
  assert.equal(state.armed, false, 'DISARMED is the default with no runtime row');
  assert.equal(state.liveEnabledSource, 'env_default');
  assert.equal(state.killSwitchSource, 'env_default');
  assert.equal(state.updatedBy, null);
  assert.equal(state.updatedAt, null);
});
