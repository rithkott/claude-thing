// Mock session source: fake sessions with evolving state + a scripted
// permission request cycle. Lets device-app development run with zero real
// Claude Code integration. Enabled with CLAUDE_THING_MOCK=1.

import { log } from '../log.js';

// Deliberately more sessions than fit on one screen so the grid's sideways
// scrolling gets exercised in dev.
const NAMES = [
  'claude-thing', 'nocturne-ui', 'credit_card_picker', 'api-server',
  'design-system', 'infra-terraform', 'docs-site', 'ml-pipeline', 'mobile-app',
];
const TOOLS = [
  ['Bash', { command: 'npm test' }],
  ['Edit', { file_path: 'src/index.js' }],
  ['Write', { file_path: 'README.md' }],
];

export function startMockSource({ store, permissionBridge, queue }) {
  let n = 0;

  // seed sessions
  const ids = NAMES.map((name, i) => {
    const id = `mock-${i}-${name}`;
    store.upsert(id, {
      name,
      cwd: `/Users/dev/${name}`,
      model: 'claude-fable-5',
      tokensIn: 1200 * (i + 1),
      tokensOut: 800 * (i + 1),
      // A spread of context fills, including one past the 80% mark, so the
      // meter's neutral-until-it-matters behaviour is visible in mock mode.
      contextTokens: Math.round([0.34, 0.62, 0.41, 0.88, 0.22, 0.55, 0.13, 0.71, 0.09][i % 9] * 1_000_000),
      lastMessage: 'Initialized mock session.',
      lastActivityTs: Date.now() - i * 60_000,
      // Every mode the badge knows, plus one session with none, so dev sees
      // the whole set — including the tile that draws no badge at all.
      permissionMode: ['plan', 'bypassPermissions', 'auto', 'default', 'acceptEdits', null][i % 6],
      // Every effort gait too, including the absent one that falls back to
      // the plain working sprite.
      effort: ['low', 'medium', 'high', 'xhigh', 'max', 'ultrathink', null][i % 7],
    });
    return id;
  });

  // activity churn: one session "works" at a time
  const churn = setInterval(() => {
    n++;
    const id = ids[n % ids.length];
    const [tool] = TOOLS[n % TOOLS.length];
    store.touch(id, {
      currentTool: tool,
      tokensIn: (store.raw(id).tokensIn || 0) + 300,
      tokensOut: (store.raw(id).tokensOut || 0) + 150,
      contextTokens: Math.min(1_000_000, (store.raw(id).contextTokens || 0) + 9_000),
      lastMessage: `Running ${tool} (mock activity #${n})`,
      stoppedTs: null,
    });
    if (n % 7 === 0) {
      store.upsert(id, { stoppedTs: Date.now(), currentTool: null, lastMessage: 'Done (mock).' });
    }
  }, 8_000);

  // scripted permission request every 60s against a fake held response
  const perm = setInterval(() => {
    const id = ids[0];
    const [tool, input] = TOOLS[n % TOOLS.length];
    const fakeRes = {
      writeHead: () => {},
      end: (body) => log('MK', `mock hook answered: ${String(body).slice(0, 80)}`),
      on: () => {},
    };
    permissionBridge.onHookRequest(
      { session_id: id, tool_name: tool, tool_input: input, cwd: `/Users/dev/${NAMES[0]}` },
      fakeRes
    );
  }, 60_000);

  // a scripted multiple-choice question so the queue can be exercised in dev
  const quest = setInterval(() => {
    if (!queue) return;
    queue.onQuestion({
      session_id: ids[1],
      tool_name: 'AskUserQuestion',
      tool_input: {
        questions: [{
          header: 'Deploy target',
          question: 'Where should this build go?',
          multiSelect: false,
          options: [
            { label: 'Staging', description: 'Safe. Runs the smoke suite first.' },
            { label: 'Production', description: 'Ships to users immediately.' },
            { label: 'Skip deploy', description: 'Build only, keep the artifact.' },
            { label: 'Preview branch', description: 'Ephemeral URL for review.' },
          ],
        }],
      },
    });
  }, 90_000);

  log('MK', `mock source: ${ids.length} sessions, permission every 60s, question every 90s`);
  return {
    stop: () => { clearInterval(churn); clearInterval(perm); clearInterval(quest); },
  };
}
