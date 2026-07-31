import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseUsage, describeFailure } from '../src/usage.js';

// Verbatim shape of `claude -p "/usage"` output.
const SAMPLE = `You are currently using your subscription to power your Claude Code usage

Current session: 11% used · resets Jul 30 at 5:19am (America/New_York)
Current week (all models): 21% used · resets Aug 4 at 4:59pm (America/New_York)
Current week (Fable): 30% used · resets Aug 4 at 5pm (America/New_York)

What's contributing to your limits usage?
Approximate, based on local sessions on this machine — does not include other devices or claude.ai.

Last 24h · 579 requests · 8 sessions
  95% of your usage came from subagent-heavy sessions
  82% of your usage was at >150k context
  Top skills: /webapp-testing 8%, /frontend-design 3%

Last 7d · 1,413 requests · 21 sessions
  55% of your usage was at >150k context
  Top subagents: Explore 10%, Plan 4%
`;

test('parses every limit line with its reset time', () => {
  const u = parseUsage(SAMPLE, 1_700_000_000_000);
  assert.equal(u.limits.length, 3);

  assert.deepEqual(
    u.limits.map((l) => [l.label, l.used]),
    [['SESSION', 0.11], ['WEEK · ALL MODELS', 0.21], ['WEEK · FABLE', 0.3]]
  );
  assert.equal(u.limits[0].detail, 'resets Jul 30 at 5:19am');
  assert.equal(u.limits[0].key, 'session');
});

test('percentages are fractions, never above 1', () => {
  const u = parseUsage(SAMPLE);
  for (const l of u.limits) {
    assert.ok(l.used >= 0 && l.used <= 1, `${l.label} out of range: ${l.used}`);
  }
});

test('parses contributing windows with comma-separated counts', () => {
  const u = parseUsage(SAMPLE);
  assert.equal(u.windows.length, 2);
  assert.deepEqual(
    u.windows.map((w) => [w.window, w.requests, w.sessions]),
    [['Last 24h', 579, 8], ['Last 7d', 1413, 21]]
  );
  assert.equal(u.windows[0].notes.length, 3);
  assert.match(u.windows[0].notes[0], /subagent-heavy/);
  // the 7d bullets must not leak into the 24h window
  assert.equal(u.windows[1].notes.length, 2);
});

test('keeps the subscription line and stamps an update label', () => {
  const u = parseUsage(SAMPLE, Date.parse('2026-07-30T05:19:00Z'));
  assert.match(u.subscription, /subscription/);
  assert.match(u.updatedLabel, /from claude \/usage/);
});

test('returns null when there are no limits to show', () => {
  assert.equal(parseUsage(''), null);
  assert.equal(parseUsage('some unrelated error text'), null);
});

test('survives a limit line with no reset clause', () => {
  const u = parseUsage('Current session: 5% used');
  assert.equal(u.limits.length, 1);
  assert.equal(u.limits[0].used, 0.05);
  assert.equal(u.limits[0].detail, '');
});

test('top-skills prose is parsed into rows the device can tabulate', () => {
  const out = parseUsage([
    'Current session: 27% used · resets Jul 31 at 2am (America/New_York)',
    'Last 24h · 775 requests · 4 sessions',
    '  94% of your usage was at >150k context',
    '  Top skills: /webapp-testing 4%, /deploy-to-dev 1%',
    '  Top subagents: Explore 7%, Plan 3%',
    '  Top MCP servers: claude-in-chrome 4%',
  ].join('\n'));
  const w = out.windows[0];
  assert.deepEqual(w.skills, [
    { name: '/webapp-testing', pct: '4%' },
    { name: '/deploy-to-dev', pct: '1%' },
  ]);
  assert.deepEqual(w.subagents, [{ name: 'Explore', pct: '7%' }, { name: 'Plan', pct: '3%' }]);
  assert.deepEqual(w.mcp, [{ name: 'claude-in-chrome', pct: '4%' }]);
  // the raw bullets survive, so a behaviour line is never lost to parsing
  assert.ok(w.notes.some((n) => /150k context/.test(n)));
});

// --- failure text -------------------------------------------------------------

const STDIN_WARNING =
  'Warning: no stdin data received in 3s, proceeding without it. If piping from a slow command, redirect stdin explicitly: < /dev/null to skip, or wait longer.';

test('a timed-out run says it timed out, not whatever stderr ended on', () => {
  const err = Object.assign(new Error('Command failed'), { killed: true, signal: 'SIGTERM' });
  const msg = describeFailure(err, STDIN_WARNING);
  assert.match(msg, /timed out after \d+s/);
  assert.ok(!/stdin/.test(msg), 'the warning is not the cause and must not read as one');
});

test('a real stderr line beats a warning above it', () => {
  const err = new Error('Command failed');
  const msg = describeFailure(err, `${STDIN_WARNING}\nError: not logged in\n`);
  assert.equal(msg, 'Error: not logged in');
});

test('with nothing but warnings, the error message itself is used', () => {
  const msg = describeFailure(new Error('spawn claude ENOENT'), STDIN_WARNING);
  assert.equal(msg, 'spawn claude ENOENT');
});
