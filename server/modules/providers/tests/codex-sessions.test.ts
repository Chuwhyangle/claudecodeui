import assert from 'node:assert/strict';
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';
import { registerMcpReadTools, type McpReadToolRegistration } from '@/modules/mcp-gateway/index.js';
import {
  CodexAppServerConnection,
  type CodexAppServerTransport,
} from '@/modules/providers/list/codex/app-server/codex-app-server.connection.js';
import { CodexHostDriver } from '@/modules/providers/list/codex/host/codex-host-driver.provider.js';
import { CodexSessionSynchronizer } from '@/modules/providers/list/codex/sessions/codex-session-synchronizer.provider.js';
import { CodexSessionsProvider, parseCodexExecScript, readCodexMemoryCitations } from '@/modules/providers/list/codex/sessions/codex-sessions.provider.js';
import { createProviderTokenUsageService } from '@/modules/providers/services/provider-token-usage.service.js';
// The token-usage service reads the registry through the shared port; evaluating the
// registry module is what installs that port.
import '@/modules/providers/provider.registry.js';
import type { IProviderHostDriverSink } from '@/shared/interfaces.js';
import type {
  ProcessHost,
  ProviderRuntimeContext,
  ProviderRuntimeWriter,
  SessionBinding,
} from '@/shared/types.js';

const patchHomeDir = (nextHomeDir: string) => {
  const original = os.homedir;
  (os as any).homedir = () => nextHomeDir;
  return () => {
    (os as any).homedir = original;
  };
};

async function withIsolatedDatabase(runTest: () => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'codex-provider-db-'));
  const databasePath = path.join(tempDirectory, 'auth.db');

  closeConnection();
  process.env.DATABASE_PATH = databasePath;
  await initializeDatabase();

  try {
    await runTest();
  } finally {
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

/**
 * Writes one Codex rollout transcript. `firstUserMessage` mirrors the
 * `event_msg`/`user_message` payload the runtime records for the prompt the
 * user typed; omitting it produces a transcript with no user turn.
 */
const writeCodexTranscript = async (
  homeDir: string,
  codexSessionId: string,
  workspacePath: string,
  firstUserMessage?: string,
): Promise<string> => {
  const sessionsDir = path.join(homeDir, '.codex', 'sessions', '2026', '07', '07');
  await mkdir(sessionsDir, { recursive: true });

  const lines: string[] = [
    JSON.stringify({ type: 'session_meta', payload: { id: codexSessionId, cwd: workspacePath } }),
  ];
  if (firstUserMessage !== undefined) {
    lines.push(JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message: firstUserMessage } }));
  }

  const filePath = path.join(sessionsDir, `rollout-${codexSessionId}.jsonl`);
  await writeFile(filePath, `${lines.join('\n')}\n`, 'utf8');
  return filePath;
};

test('Codex synchronizer preserves the title assigned when Cloudpit creates a session', { concurrency: false }, async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'codex-session-sync-app-'));
  const workspacePath = path.join(tempRoot, 'workspace');
  await mkdir(workspacePath, { recursive: true });
  const restoreHomeDir = patchHomeDir(tempRoot);

  try {
    await writeCodexTranscript(tempRoot, 'codex-app-1', workspacePath, 'Provider transcript title must not win');
    await withIsolatedDatabase(async () => {
      // The app allocates its own id and later maps the provider id onto it,
      // exactly as a message sent from cloudcli does.
      sessionsDb.createAppSession('app-1', 'codex', workspacePath, 'Fix the login redirect');
      sessionsDb.assignProviderSessionId('app-1', 'codex-app-1');

      const synchronizer = new CodexSessionSynchronizer();
      await synchronizer.synchronize();

      assert.equal(sessionsDb.getSessionById('app-1')?.custom_name, 'Fix the login redirect');
    });
  } finally {
    restoreHomeDir();
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('Codex synchronizer skips sub-agent rollout files', { concurrency: false }, async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'codex-session-sync-subagent-'));
  const workspacePath = path.join(tempRoot, 'workspace');
  await mkdir(workspacePath, { recursive: true });
  const restoreHomeDir = patchHomeDir(tempRoot);

  try {
    // Codex >=0.144 spawn_agent threads write their own rollout files into the
    // same sessions tree, marked via thread_source/source in session_meta.
    const sessionsDir = path.join(tempRoot, '.codex', 'sessions', '2026', '07', '07');
    await mkdir(sessionsDir, { recursive: true });
    await writeFile(
      path.join(sessionsDir, 'rollout-codex-subagent-1.jsonl'),
      `${JSON.stringify({
        type: 'session_meta',
        payload: {
          id: 'codex-subagent-1',
          cwd: workspacePath,
          thread_source: 'subagent',
          parent_thread_id: 'codex-parent-1',
          source: { subagent: { thread_spawn: { parent_thread_id: 'codex-parent-1', depth: 1 } } },
        },
      })}\n`,
      'utf8'
    );
    await writeCodexTranscript(tempRoot, 'codex-parent-1', workspacePath);

    await withIsolatedDatabase(async () => {
      const synchronizer = new CodexSessionSynchronizer();
      const processed = await synchronizer.synchronize();

      assert.equal(processed, 1);
      assert.ok(sessionsDb.getSessionById('codex-parent-1'));
      assert.equal(sessionsDb.getSessionById('codex-subagent-1'), null);
    });
  } finally {
    restoreHomeDir();
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('Codex synchronizer leaves indexed sessions untitled when no name is available', { concurrency: false }, async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'codex-session-sync-indexed-'));
  const workspacePath = path.join(tempRoot, 'workspace');
  await mkdir(workspacePath, { recursive: true });
  const restoreHomeDir = patchHomeDir(tempRoot);

  try {
    // A CLI-created session has no app row; its first user message must NOT be
    // used as the title, preserving the existing indexing behavior.
    await writeCodexTranscript(tempRoot, 'codex-indexed-1', workspacePath, 'This prompt should be ignored');
    await withIsolatedDatabase(async () => {
      const synchronizer = new CodexSessionSynchronizer();
      await synchronizer.synchronize();

      assert.equal(sessionsDb.getSessionById('codex-indexed-1')?.custom_name, 'Untitled Codex Session');
    });
  } finally {
    restoreHomeDir();
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('Codex history translates wrapped exec scripts into the tools they ran', { concurrency: false }, async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'codex-exec-history-'));
  const workspacePath = path.join(tempRoot, 'workspace');
  await mkdir(workspacePath, { recursive: true });
  const restoreHomeDir = patchHomeDir(tempRoot);

  try {
    const providerSessionId = 'codex-exec-1';
    const transcriptPath = await writeCodexTranscript(tempRoot, providerSessionId, workspacePath);
    // Every shape Codex's "code mode" emits. Only a wrapper nothing recognizes
    // may stay labelled `exec`; the rest must name the work they performed.
    const wrappedCalls = [
      {
        callId: 'shell-command-1',
        input: 'const cmds = ["echo one", "echo two"]; await Promise.all(cmds.map(command => tools.shell_command({ command })));',
        expectedToolName: 'Bash',
        expectedToolInput: JSON.stringify({ command: 'echo one\necho two' }),
      },
      {
        callId: 'json-shell-command-1',
        input: 'const r = await tools.shell_command({"command":"Get-Content -Raw README.md","workdir":"C:\\\\workspace","timeout_ms":10000}); text(r)',
        expectedToolName: 'Bash',
        expectedToolInput: JSON.stringify({ command: 'Get-Content -Raw README.md' }),
      },
      {
        callId: 'exec-command-1',
        input: 'await tools.exec_command({"cmd":"npm test","workdir":"/repo","yield_time_ms":10000});',
        expectedToolName: 'Bash',
        expectedToolInput: JSON.stringify({ command: 'npm test' }),
      },
      {
        callId: 'web-run-1',
        input: 'await tools.web__run({ search_query: [{ q: "Codex" }, { q: "rollout format" }] });',
        expectedToolName: 'WebSearch',
        expectedToolInput: JSON.stringify({ query: 'Codex | rollout format' }),
      },
      {
        callId: 'unknown-1',
        input: 'await tools.unknown_wrapper({ value: true });',
        expectedToolName: 'exec',
        expectedToolInput: 'await tools.unknown_wrapper({ value: true });',
      },
    ];
    const transcriptLines = [
      JSON.stringify({ type: 'session_meta', payload: { id: providerSessionId, cwd: workspacePath } }),
    ];
    for (const call of wrappedCalls) {
      transcriptLines.push(
        JSON.stringify({
          type: 'response_item',
          payload: { type: 'custom_tool_call', name: 'exec', call_id: call.callId, input: call.input },
        }),
        JSON.stringify({
          type: 'response_item',
          payload: { type: 'custom_tool_call_output', call_id: call.callId, output: `result:${call.callId}` },
        }),
      );
    }
    await writeFile(transcriptPath, `${transcriptLines.join('\n')}\n`, 'utf8');

    await withIsolatedDatabase(async () => {
      sessionsDb.createAppSession('app-exec-1', 'codex', workspacePath);
      sessionsDb.assignProviderSessionId('app-exec-1', providerSessionId);
      await new CodexSessionSynchronizer().synchronize();

      const history = await new CodexSessionsProvider().fetchHistory('app-exec-1');
      const toolUses = history.messages.filter((message) => message.kind === 'tool_use');
      const toolUsesById = new Map(toolUses.map((message) => [message.toolId, message]));

      assert.equal(toolUses.length, wrappedCalls.length);
      for (const call of wrappedCalls) {
        const toolUse = toolUsesById.get(call.callId);
        assert.ok(toolUse, `missing row for ${call.callId}`);
        assert.equal(toolUse.toolName, call.expectedToolName);
        assert.equal(toolUse.toolInput, call.expectedToolInput);
        assert.equal(toolUse.toolResult?.content, `result:${call.callId}`);
      }
    });
  } finally {
    restoreHomeDir();
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('Codex history strips the sandbox envelopes from shell output', { concurrency: false }, async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'codex-exec-output-'));
  const workspacePath = path.join(tempRoot, 'workspace');
  await mkdir(workspacePath, { recursive: true });
  const restoreHomeDir = patchHomeDir(tempRoot);

  try {
    const providerSessionId = 'codex-output-1';
    const transcriptPath = await writeCodexTranscript(tempRoot, providerSessionId, workspacePath);
    await writeFile(transcriptPath, `${[
      JSON.stringify({ type: 'session_meta', payload: { id: providerSessionId, cwd: workspacePath } }),
      JSON.stringify({
        type: 'response_item',
        payload: {
          type: 'custom_tool_call',
          name: 'exec',
          call_id: 'failing-1',
          input: 'await tools.shell_command({ command: "npm test" });',
        },
      }),
      // Codex nests two report headers: one for the sandbox script and one for
      // the command it ran. Neither belongs in a chat transcript.
      JSON.stringify({
        type: 'response_item',
        payload: {
          type: 'custom_tool_call_output',
          call_id: 'failing-1',
          output: [
            { type: 'input_text', text: 'Script failed\nWall time 1.2 seconds\nOutput:\n' },
            { type: 'input_text', text: 'Script error:\nExit code: 1\nWall time: 1.1 seconds\nOutput:\n1 test failed\n' },
          ],
        },
      }),
    ].join('\n')}\n`, 'utf8');

    await withIsolatedDatabase(async () => {
      sessionsDb.createAppSession('app-output-1', 'codex', workspacePath);
      sessionsDb.assignProviderSessionId('app-output-1', providerSessionId);
      await new CodexSessionSynchronizer().synchronize();

      const history = await new CodexSessionsProvider().fetchHistory('app-output-1');
      const bash = history.messages.find((message) => message.kind === 'tool_use');

      assert.equal(bash?.toolName, 'Bash');
      assert.equal(bash?.toolResult?.content, '1 test failed\n');
      assert.equal(bash?.toolResult?.isError, true, 'a non-zero exit code must mark the row failed');
    });
  } finally {
    restoreHomeDir();
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('Codex history renders one file row per patched file, from the applied diff', { concurrency: false }, async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'codex-patch-history-'));
  const workspacePath = path.join(tempRoot, 'workspace');
  await mkdir(workspacePath, { recursive: true });
  const restoreHomeDir = patchHomeDir(tempRoot);

  try {
    const providerSessionId = 'codex-patch-1';
    const transcriptPath = await writeCodexTranscript(tempRoot, providerSessionId, workspacePath);
    const patch = [
      '*** Begin Patch',
      '*** Update File: /repo/a.ts',
      '@@',
      '-const a = 1;',
      '+const a = 2;',
      '*** Update File: /repo/b.ts',
      '@@',
      '-const b = 1;',
      '+const b = 2;',
      '*** End Patch',
    ].join('\n');

    await writeFile(transcriptPath, `${[
      JSON.stringify({ type: 'session_meta', payload: { id: providerSessionId, cwd: workspacePath } }),
      JSON.stringify({
        type: 'response_item',
        payload: { type: 'custom_tool_call', name: 'apply_patch', call_id: 'patch-1', input: patch },
      }),
      // The out-of-band report carries the real diffs, keyed by path in an
      // order that does not follow the patch body.
      JSON.stringify({
        type: 'event_msg',
        payload: {
          type: 'patch_apply_end',
          call_id: 'patch-1',
          success: true,
          changes: {
            '/repo/b.ts': { type: 'update', unified_diff: '@@\n-const b = 1;\n+const b = 22;\n' },
            '/repo/a.ts': { type: 'update', unified_diff: '@@\n-const a = 1;\n+const a = 22;\n' },
          },
        },
      }),
      JSON.stringify({
        type: 'response_item',
        payload: { type: 'custom_tool_call_output', call_id: 'patch-1', output: '{}' },
      }),
    ].join('\n')}\n`, 'utf8');

    await withIsolatedDatabase(async () => {
      sessionsDb.createAppSession('app-patch-1', 'codex', workspacePath);
      sessionsDb.assignProviderSessionId('app-patch-1', providerSessionId);
      await new CodexSessionSynchronizer().synchronize();

      const history = await new CodexSessionsProvider().fetchHistory('app-patch-1');
      const edits = history.messages.filter((message) => message.kind === 'tool_use');

      assert.equal(edits.length, 2, 'the patch must not be rendered twice');
      const byPath = new Map(edits.map((edit) => {
        const input = JSON.parse(String(edit.toolInput)) as { file_path: string; new_string: string };
        return [input.file_path, { edit, input }];
      }));

      assert.equal(byPath.get('/repo/a.ts')?.edit.toolName, 'Edit');
      // The applied diff wins over the one reconstructed from the call input,
      // and it must land on the row for its own file.
      assert.equal(byPath.get('/repo/a.ts')?.input.new_string, 'const a = 22;');
      assert.equal(byPath.get('/repo/b.ts')?.input.new_string, 'const b = 22;');
      for (const edit of edits) {
        assert.equal(edit.toolResult?.isError, false, 'a successful patch must resolve its row');
      }
    });
  } finally {
    restoreHomeDir();
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('Codex history attaches a spawned agent\'s own transcript to the Task row', { concurrency: false }, async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'codex-subagent-history-'));
  const workspacePath = path.join(tempRoot, 'workspace');
  await mkdir(workspacePath, { recursive: true });
  const restoreHomeDir = patchHomeDir(tempRoot);

  try {
    const providerSessionId = 'codex-parent-2';
    const agentThreadId = 'codex-agent-thread-2';
    const transcriptPath = await writeCodexTranscript(tempRoot, providerSessionId, workspacePath);

    await writeFile(transcriptPath, `${[
      JSON.stringify({ type: 'session_meta', payload: { id: providerSessionId, cwd: workspacePath } }),
      JSON.stringify({
        type: 'response_item',
        payload: {
          type: 'function_call',
          name: 'spawn_agent',
          call_id: 'spawn-1',
          arguments: JSON.stringify({ task_name: 'test_agent_1' }),
        },
      }),
      JSON.stringify({
        type: 'event_msg',
        payload: {
          type: 'sub_agent_activity',
          kind: 'started',
          event_id: 'spawn-1',
          agent_thread_id: agentThreadId,
          agent_path: '/root/test_agent_1',
        },
      }),
      JSON.stringify({
        type: 'response_item',
        payload: {
          type: 'agent_message',
          author: '/root/test_agent_1',
          content: [{ type: 'input_text', text: 'Message Type: FINAL_ANSWER\nSender: /root/test_agent_1\nPayload:\nAll done.' }],
        },
      }),
    ].join('\n')}\n`, 'utf8');

    // Codex writes a spawned agent's rollout next to its parent's, named after
    // the agent thread id.
    await writeFile(
      path.join(path.dirname(transcriptPath), `rollout-2026-07-07T00-00-00-${agentThreadId}.jsonl`),
      `${[
        JSON.stringify({
          type: 'session_meta',
          payload: { id: agentThreadId, cwd: workspacePath, thread_source: 'subagent', agent_nickname: 'Hegel' },
        }),
        JSON.stringify({
          type: 'response_item',
          payload: {
            type: 'custom_tool_call',
            name: 'exec',
            call_id: 'agent-call-1',
            input: 'await tools.shell_command({ command: "ls" });',
          },
        }),
        JSON.stringify({
          type: 'response_item',
          payload: { type: 'custom_tool_call_output', call_id: 'agent-call-1', output: 'Exit code: 0\nOutput:\nREADME.md\n' },
        }),
      ].join('\n')}\n`,
      'utf8',
    );

    await withIsolatedDatabase(async () => {
      sessionsDb.createAppSession('app-parent-2', 'codex', workspacePath);
      sessionsDb.assignProviderSessionId('app-parent-2', providerSessionId);
      await new CodexSessionSynchronizer().synchronize();

      const history = await new CodexSessionsProvider().fetchHistory('app-parent-2');
      const task = history.messages.find((message) => message.kind === 'tool_use' && message.toolName === 'Task');

      assert.ok(task, 'a spawned agent must produce a Task row');
      assert.equal(task.subagent?.id, agentThreadId);
      assert.equal(task.subagent?.name, 'Hegel');
      assert.equal(task.subagent?.status, 'completed');
      assert.equal(task.toolResult?.content, 'All done.');

      // The agent's own shell call is translated exactly like the parent's.
      assert.equal(task.subagentTools?.length, 1);
      assert.equal(task.subagentTools?.[0].kind, 'tool');
      assert.equal(task.subagentTools?.[0].toolName, 'Bash');
      assert.equal(task.subagentTools?.[0].toolResult?.content, 'README.md\n');
    });
  } finally {
    restoreHomeDir();
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('Codex memory citations are lifted out of the reply they trail', () => {
  const reply = [
    'Here is the answer.',
    '',
    '<oai-mem-citation>',
    '<citation_entries>',
    'MEMORY.md:137-142|note=[used verified container provisioning details]',
    'notes/deploy.md:4-9',
    '</citation_entries>',
    '<rollout_ids>',
    '019eda6d-c2f7-70c1-8b42-bf03c44a1f35',
    '</rollout_ids>',
    '</oai-mem-citation>',
  ].join('\n');

  const { text, memoryCitations } = readCodexMemoryCitations(reply);

  assert.equal(text, 'Here is the answer.');
  assert.deepEqual(memoryCitations, [
    { source: 'MEMORY.md:137-142', note: 'used verified container provisioning details' },
    { source: 'notes/deploy.md:4-9' },
  ]);
});

test('a plan followed by a memory citation is still recognized as a plan', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'codex-plan-citation-'));
  const workspacePath = path.join(tempRoot, 'workspace');
  await mkdir(workspacePath, { recursive: true });
  const restoreHomeDir = patchHomeDir(tempRoot);

  try {
    const providerSessionId = 'codex-plan-citation-1';
    const sessionsDir = path.join(tempRoot, '.codex', 'sessions', '2026', '07', '07');
    await mkdir(sessionsDir, { recursive: true });
    await writeFile(path.join(sessionsDir, `rollout-${providerSessionId}.jsonl`), `${[
      JSON.stringify({ type: 'session_meta', payload: { id: providerSessionId, cwd: workspacePath } }),
      JSON.stringify({
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'assistant',
          id: 'plan-1',
          content: [{
            type: 'output_text',
            text: '<proposed_plan>\n# Ship it\n</proposed_plan>\n\n<oai-mem-citation>\n<citation_entries>\nMEMORY.md:1-2|note=[prior deploy steps]\n</citation_entries>\n</oai-mem-citation>',
          }],
        },
      }),
    ].join('\n')}\n`, 'utf8');

    await withIsolatedDatabase(async () => {
      sessionsDb.createAppSession('app-plan-citation-1', 'codex', workspacePath);
      sessionsDb.assignProviderSessionId('app-plan-citation-1', providerSessionId);
      await new CodexSessionSynchronizer().synchronize();

      const history = await new CodexSessionsProvider().fetchHistory('app-plan-citation-1');
      const plan = history.messages.find((message) => message.toolName === 'ExitPlanMode');

      assert.ok(plan, 'the trailing citation block must not hide the plan envelope');
      assert.equal(JSON.parse(String(plan.toolInput)).plan, '# Ship it');
      assert.deepEqual(plan.memoryCitations, [{ source: 'MEMORY.md:1-2', note: 'prior deploy steps' }]);
      assert.ok(
        !history.messages.some((message) => JSON.stringify(message).includes('oai-mem-citation')),
        'no transcript row may still carry the raw citation markup',
      );
    });
  } finally {
    restoreHomeDir();
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('an exec script that updates the plan yields the steps it set', () => {
  const operations = parseCodexExecScript([
    'const p = await tools.update_plan({plan:[',
    '  {step:"Confirm the current workspace",status:"completed"},',
    '  {step:"Check the Git working-tree status",status:"in_progress"},',
    '  {step:"Identify the project",status:"pending"}',
    ']});',
    'text(p);',
  ].join('\n'));

  assert.deepEqual(operations, [{
    kind: 'plan',
    todos: [
      { content: 'Confirm the current workspace', status: 'completed' },
      { content: 'Check the Git working-tree status', status: 'in_progress' },
      { content: 'Identify the project', status: 'pending' },
    ],
  }]);
});


test('Codex history restores user prompts from typed item_completed rows', { concurrency: false }, async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'codex-typed-user-history-'));
  const workspacePath = path.join(tempRoot, 'workspace');
  await mkdir(workspacePath, { recursive: true });
  const restoreHomeDir = patchHomeDir(tempRoot);

  try {
    const providerSessionId = 'codex-typed-1';
    const prompt = 'Typed prompt that must survive a refresh';
    const transcriptPath = path.join(tempRoot, '.codex', 'sessions', '2026', '07', '07', 'rollout-' + providerSessionId + '.jsonl');
    await mkdir(path.dirname(transcriptPath), { recursive: true });
    const lineEnd = String.fromCharCode(10);
    const typedLine = JSON.stringify({
      timestamp: '2026-09-07T17:59:17.000Z',
      type: 'event_msg',
      payload: {
        type: 'item_completed',
        turn_id: 'typed-turn-1',
        item: {
          type: 'UserMessage',
          id: 'item-user-1',
          content: [
            { type: 'text', text: prompt, text_elements: [] },
            { type: 'local_image', path: '/tmp/prompt-picture.png', detail: null },
          ],
        },
      },
    });
    const wireUserEcho = JSON.stringify({
      timestamp: '2026-09-07T17:59:19.000Z',
      type: 'response_item',
      payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: prompt }] },
    });
    await writeFile(
      transcriptPath,
      [JSON.stringify({ type: 'session_meta', payload: { id: providerSessionId, cwd: workspacePath } }), typedLine, wireUserEcho].join(lineEnd) + lineEnd,
      'utf8',
    );

    await withIsolatedDatabase(async () => {
      sessionsDb.createAppSession('app-typed-1', 'codex', workspacePath);
      sessionsDb.assignProviderSessionId('app-typed-1', providerSessionId);
      await new CodexSessionSynchronizer().synchronize();

      const history = await new CodexSessionsProvider().fetchHistory('app-typed-1');
      const users = history.messages.filter((message) => message.role === 'user');
      const images = users[0]?.images as Array<{ path?: string; data?: string }> | undefined;

      assert.equal(users.length, 1, 'the wire user echo must not duplicate the typed prompt');
      assert.equal(users[0]?.content, prompt);
      assert.equal(images?.[0]?.path, '/tmp/prompt-picture.png');
    });
  } finally {
    restoreHomeDir();
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('a Codex turn anchors its last assistant answer with the turn id', { concurrency: false }, async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'codex-fork-anchors-'));
  const workspacePath = path.join(tempRoot, 'workspace');
  await mkdir(workspacePath, { recursive: true });
  const restoreHomeDir = patchHomeDir(tempRoot);

  try {
    const providerSessionId = 'codex-fork-1';
    const transcriptPath = path.join(
      tempRoot, '.codex', 'sessions', '2026', '07', '07', `rollout-${providerSessionId}.jsonl`,
    );
    await mkdir(path.dirname(transcriptPath), { recursive: true });

    const lineEnd = String.fromCharCode(10);
    const started = (turnId: string) =>
      JSON.stringify({ type: 'event_msg', payload: { type: 'task_started', turn_id: turnId } });
    const prompt = (turnId: string, text: string) =>
      JSON.stringify({
        type: 'event_msg',
        payload: {
          type: 'item_completed',
          turn_id: turnId,
          item: { type: 'UserMessage', id: `item-${turnId}`, content: [{ type: 'text', text }] },
        },
      });
    const answer = (text: string, timestamp: string) =>
      JSON.stringify({
        timestamp,
        type: 'response_item',
        payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] },
      });

    // Two turns: the second holds an intermediate narration before its answer,
    // so the anchor must land on the final row, not the narration.
    const lines = [
      JSON.stringify({ type: 'session_meta', payload: { id: providerSessionId, cwd: workspacePath } }),
      started('turn-1'),
      prompt('turn-1', 'first question'),
      answer('first answer', '2026-09-07T18:00:01.000Z'),
      started('turn-2'),
      prompt('turn-2', 'second question'),
      answer('let me check', '2026-09-07T18:00:02.000Z'),
      answer('second answer', '2026-09-07T18:00:03.000Z'),
    ];
    await writeFile(transcriptPath, `${lines.join(lineEnd)}${lineEnd}`, 'utf8');

    await withIsolatedDatabase(async () => {
      sessionsDb.createAppSession('app-fork-1', 'codex', workspacePath);
      sessionsDb.assignProviderSessionId('app-fork-1', providerSessionId);
      await new CodexSessionSynchronizer().synchronize();

      const history = await new CodexSessionsProvider().fetchHistory('app-fork-1');
      const anchored = history.messages.filter((message) => message.forkAnchorId);

      assert.deepEqual(
        anchored.map((message) => [message.role, message.content, message.forkAnchorId]),
        [
          ['assistant', 'first answer', 'turn-1'],
          ['assistant', 'second answer', 'turn-2'],
        ],
      );

      const narration = history.messages.find((message) => message.content === 'let me check');
      assert.ok(narration);
      assert.equal(narration.forkAnchorId, undefined, 'a mid-turn narration is not the fork point');

      const users = history.messages.filter((message) => message.role === 'user');
      assert.equal(users.length, 2);
      assert.equal(users.some((message) => message.forkAnchorId), false, 'user prompts never carry a fork anchor');
    });
  } finally {
    restoreHomeDir();
    await rm(tempRoot, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Resident transcripts (gap-codex-resident-session-read-empty)
//
// A resident Codex conversation lives inside the app-server's thread, not in a
// `~/.codex/sessions` rollout, so its session row had no `jsonl_path` and
// `session_read` rendered an empty string. These criteria drive a real
// `CodexHostDriver` turn over an in-memory app-server transport and read the
// session back through the same provider the MCP read tool uses.
// ---------------------------------------------------------------------------

const RESIDENT_THREAD_ID = 'resident-thread-transcript-1';

/** A minimal app-server stub: one thread, one answered turn carrying `assistantText`. */
class ResidentTranscriptTransport implements CodexAppServerTransport {
  readonly pid = 717_171;

  private messageHandler: ((frame: string) => void) | null = null;
  private alive = true;

  constructor(private readonly assistantText: string) {}

  write(frame: string): void {
    const message = JSON.parse(frame) as {
      id?: number;
      method?: string;
      params?: Record<string, unknown>;
    };
    if (typeof message.method !== 'string') {
      return;
    }
    if (message.method === 'initialize') {
      this.reply(message.id, { userAgent: 'fake-codex/0.153.4' });
      return;
    }
    if (message.method === 'initialized') {
      return;
    }
    if (message.method === 'thread/start') {
      this.reply(message.id, { thread: { id: RESIDENT_THREAD_ID, status: { type: 'idle' } } });
      return;
    }
    if (message.method === 'turn/start') {
      const turnId = 'resident-turn-transcript-1';
      this.reply(message.id, { turn: { id: turnId, status: 'inProgress' } });
      // The resident app-server's own transcript: only these notifications
      // carry the answer, and nothing writes them to a rollout file.
      this.emit('turn/started', { threadId: RESIDENT_THREAD_ID, turn: { id: turnId, status: 'inProgress' } });
      this.emit('item/completed', {
        threadId: RESIDENT_THREAD_ID,
        item: { id: 'resident-item-transcript-1', type: 'agentMessage', text: this.assistantText },
      });
      this.emit('turn/completed', { threadId: RESIDENT_THREAD_ID, turn: { id: turnId, status: 'completed' } });
    }
  }

  onMessage(handler: (frame: string) => void): void {
    this.messageHandler = handler;
  }

  onExit(): void {}

  isAlive(): boolean {
    return this.alive;
  }

  terminate(): void {
    this.alive = false;
  }

  private reply(id: number | undefined, result: unknown): void {
    this.deliver({ jsonrpc: '2.0', id, result });
  }

  private emit(method: string, params: unknown): void {
    this.deliver({ jsonrpc: '2.0', method, params });
  }

  private deliver(value: unknown): void {
    if (this.alive) {
      this.messageHandler?.(JSON.stringify(value));
    }
  }
}

function residentHost(appSessionId: string): ProcessHost {
  return {
    hostId: `resident-host-${appSessionId}`,
    provider: 'codex',
    mode: 'resident',
    state: 'starting',
    pid: null,
    startedAt: Date.now(),
    bindings: new Map(),
    closeReason: null,
  };
}

/** Drives one resident turn through the driver and returns the host it used. */
async function runResidentTurn(
  appSessionId: string,
  prompt: string,
  assistantText: string,
): Promise<ProcessHost> {
  const transport = new ResidentTranscriptTransport(assistantText);
  const driver = new CodexHostDriver({
    createConnection: (launch) => new CodexAppServerConnection({
      launch,
      createTransport: () => transport,
    }),
  });
  const host = residentHost(appSessionId);
  const sink: IProviderHostDriverSink = {
    leaseAdded: () => {},
    leaseRemoved: () => {},
    activity: () => {},
    identity: () => {},
    exited: () => {},
  };
  const binding: SessionBinding = {
    appSessionId,
    providerSessionId: null,
    state: 'idle',
    leases: [],
    lastActivityAt: Date.now(),
    peerName: null,
    detachReason: null,
  };
  await driver.startHost(host, sink);
  await driver.bind(host, binding);
  const writer: ProviderRuntimeWriter = { send: () => {} };
  const context = { resolveProviderSessionId: () => null } as unknown as ProviderRuntimeContext;
  try {
    await driver.run(appSessionId, { command: prompt, options: {} }, writer, context);
  } finally {
    await driver.closeHost(host, 'user');
  }
  return host;
}

test('a resident-shaped Codex session with no persisted turn reads empty (red baseline)', { concurrency: false }, async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'codex-resident-empty-'));
  const workspacePath = path.join(tempRoot, 'workspace');
  await mkdir(workspacePath, { recursive: true });
  const restoreHomeDir = patchHomeDir(tempRoot);

  try {
    await withIsolatedDatabase(async () => {
      // The shape the defect reported: a resident conversation has a thread id
      // but no rollout file, so there is nothing for the reader to open.
      sessionsDb.createAppSession('app-resident-empty', 'codex', workspacePath);
      sessionsDb.assignProviderSessionId('app-resident-empty', 'resident-thread-empty');
      assert.equal(sessionsDb.getSessionById('app-resident-empty')?.jsonl_path, null);

      const history = await new CodexSessionsProvider().fetchHistory('app-resident-empty');

      assert.deepEqual(history.messages, []);
      assert.equal(history.total, 0);
    });
  } finally {
    restoreHomeDir();
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('a resident turn is persisted outside the scanned sessions tree and reads back', { concurrency: false }, async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'codex-resident-transcript-'));
  const workspacePath = path.join(tempRoot, 'workspace');
  await mkdir(workspacePath, { recursive: true });
  const restoreHomeDir = patchHomeDir(tempRoot);
  const appSessionId = 'app-resident-transcript';
  const prompt = 'Summarize the build result';
  const answer = 'Build passed with no warnings.';

  try {
    await withIsolatedDatabase(async () => {
      sessionsDb.createAppSession(appSessionId, 'codex', workspacePath);
      await runResidentTurn(appSessionId, prompt, answer);

      const row = sessionsDb.getSessionById(appSessionId);
      assert.ok(row?.jsonl_path, 'the resident turn must link the session row to its transcript');
      const transcriptPath = row.jsonl_path as string;
      // The synchronizer indexes every rollout under ~/.codex/sessions as a
      // separate per-run session, so the resident file must live outside it.
      assert.equal(
        transcriptPath.startsWith(path.join(tempRoot, '.codex', 'sessions')),
        false,
        'the resident transcript must not be inside the scanned sessions tree',
      );
      assert.ok(transcriptPath.startsWith(path.join(tempRoot, '.cloudcli')));

      const transcript = await readFile(transcriptPath, 'utf8');
      assert.ok(transcript.includes(prompt), 'the persisted turn must carry the user prompt');
      assert.ok(transcript.includes(answer), 'the persisted turn must carry the assistant answer');

      const provider = new CodexSessionsProvider();
      const history = await provider.fetchHistory(appSessionId);
      const assistant = history.messages.find((message) => message.kind === 'text' && message.role === 'assistant');
      assert.equal(assistant?.content, answer);

      // AC2's session_read leg: register the real read tool set over a deps bag
      // whose `fetchHistory` is the provider above, then ask for latest mode.
      const deps = {
        sessions: {
          fetchHistory: (sessionId: string, options?: { limit?: number | null; offset?: number }) =>
            provider.fetchHistory(sessionId, options),
        },
      } as unknown as Parameters<typeof registerMcpReadTools>[1];
      const registrations = new Map<string, McpReadToolRegistration>();
      registerMcpReadTools((registration) => registrations.set(registration.name, registration), deps);
      const sessionRead = registrations.get('session_read');
      assert.ok(sessionRead, 'the read tool set must register session_read');
      const rendered = await sessionRead.handler({ session: appSessionId, mode: 'latest' }) as {
        content?: string;
      };
      assert.ok((rendered.content ?? '').length > 0, 'session_read must render non-empty content');

      // AC4's fake form: remove the persisted turn (the step this task adds)
      // and the very same read goes empty; put it back and it is green again.
      const persisted = await readFile(transcriptPath, 'utf8');
      await rm(transcriptPath);
      const withoutPersistedTurn = await provider.fetchHistory(appSessionId);
      assert.deepEqual(withoutPersistedTurn.messages, [], 'without the persisted transcript the read is empty again');
      assert.equal(withoutPersistedTurn.total, 0);

      await writeFile(transcriptPath, persisted, 'utf8');
      const restored = await provider.fetchHistory(appSessionId);
      assert.ok(
        restored.messages.some((message) => message.kind === 'text' && message.content === answer),
        'restoring the persisted turn restores the reading',
      );
    });
  } finally {
    restoreHomeDir();
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('a per-run Codex rollout still reads its own transcript unchanged', { concurrency: false }, async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'codex-per-run-regression-'));
  const workspacePath = path.join(tempRoot, 'workspace');
  await mkdir(workspacePath, { recursive: true });
  const restoreHomeDir = patchHomeDir(tempRoot);
  const providerSessionId = 'codex-per-run-1';

  try {
    const transcriptPath = await writeCodexTranscript(
      tempRoot,
      providerSessionId,
      workspacePath,
      'per-run prompt',
    );
    await appendFile(transcriptPath, `${JSON.stringify({
      timestamp: '2026-07-07T12:00:01.000Z',
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'per-run answer' }],
      },
    })}\n`, 'utf8');

    await withIsolatedDatabase(async () => {
      sessionsDb.createAppSession('app-per-run-1', 'codex', workspacePath);
      sessionsDb.assignProviderSessionId('app-per-run-1', providerSessionId);
      await new CodexSessionSynchronizer().synchronize();

      const history = await new CodexSessionsProvider().fetchHistory('app-per-run-1');

      assert.equal(sessionsDb.getSessionById('app-per-run-1')?.jsonl_path, transcriptPath);
      assert.ok(history.messages.some((message) => message.kind === 'text' && message.content === 'per-run answer'));
      assert.ok(history.messages.some((message) => message.role === 'user' && message.content === 'per-run prompt'));
    });
  } finally {
    restoreHomeDir();
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('Codex history and the token-usage endpoint describe the same snapshot', { concurrency: false }, async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'codex-token-usage-consistency-'));
  const workspacePath = path.join(tempRoot, 'workspace');
  await mkdir(workspacePath, { recursive: true });
  const restoreHomeDir = patchHomeDir(tempRoot);

  try {
    const providerSessionId = 'codex-usage-1';
    const transcriptPath = await writeCodexTranscript(tempRoot, providerSessionId, workspacePath);
    const info = {
      total_token_usage: {
        input_tokens: 2_000,
        cached_input_tokens: 1_500,
        output_tokens: 400,
        reasoning_output_tokens: 150,
        total_tokens: 2_400,
      },
      last_token_usage: {
        input_tokens: 700,
        cached_input_tokens: 500,
        output_tokens: 120,
        reasoning_output_tokens: 60,
        total_tokens: 820,
      },
      model_context_window: 258_400,
    };
    await writeFile(transcriptPath, `${[
      JSON.stringify({ type: 'session_meta', payload: { id: providerSessionId, cwd: workspacePath } }),
      JSON.stringify({
        timestamp: '2026-10-30T09:30:00.000Z',
        type: 'event_msg',
        payload: { type: 'token_count', info },
      }),
    ].join('\n')}\n`, 'utf8');

    await withIsolatedDatabase(async () => {
      sessionsDb.createAppSession('app-usage-1', 'codex', workspacePath);
      sessionsDb.assignProviderSessionId('app-usage-1', providerSessionId);
      await new CodexSessionSynchronizer().synchronize();

      const history = await new CodexSessionsProvider().fetchHistory('app-usage-1');
      const endpointReading = await createProviderTokenUsageService().getSessionTokenUsage('app-usage-1');

      // The realtime path reads the same normalizer from the same rollout, so a
      // matching history + endpoint pair is the observable half of "all three
      // surfaces agree". Assert the reading's shape here, not just equality.
      assert.deepEqual(history.tokenUsage, endpointReading);
      assert.equal(endpointReading.usageScope, 'session-cumulative');
      assert.equal(endpointReading.used, 2_400);
      assert.equal(endpointReading.total, 258_400);
      assert.deepEqual(endpointReading.cumulative, {
        inputTokens: 2_000,
        outputTokens: 400,
        cacheReadTokens: 1_500,
        reasoningOutputTokens: 150,
        totalTokens: 2_400,
      });
      assert.deepEqual(endpointReading.lastRequest, {
        inputTokens: 700,
        outputTokens: 120,
        cacheReadTokens: 500,
        reasoningOutputTokens: 60,
        totalTokens: 820,
      });
      assert.equal(endpointReading.observedAt, '2026-10-30T09:30:00.000Z');
    });
  } finally {
    restoreHomeDir();
    await rm(tempRoot, { recursive: true, force: true });
  }
});
