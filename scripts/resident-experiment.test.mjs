#!/usr/bin/env node
// resident-experiment.test.mjs — `scripts/resident-experiment.mjs` 的护栏判据。
//
// 为什么这些护栏值得有自己的测试
// ------------------------------
// 实验台会在本机起真实的 `claude` 进程并写库。本机 shell 已导出 `DATABASE_PATH`
// （`/data/home/yale/.cloudcli/auth.db`，真实库），而实验必须写**临时**库。一次手滑就是往生产库
// 里写会话，所以"必须显式给临时库"这条不是风格问题，是唯一挡住这件事的东西——它必须被钉住。
//
// 覆盖（对应任务 AC1）：
//   1. 未显式给临时 DATABASE_PATH 时拒绝运行（三条：缺省、等于环境里的值、不在临时根下）；
//   2. `--check-record` 对缺节记录 exit 1 并点名缺的小节；
//   3. 受保护端口 3001 被拒。
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  GuardRefusal,
  SECTION_IDS,
  assertIsolatedDatabasePath,
  assertSafePort,
  checkRecordFile,
  checkRecordText,
  extractSection,
  upsertSection,
} from './resident-experiment.mjs';

const SCRIPT = fileURLToPath(new URL('./resident-experiment.mjs', import.meta.url));
/** 本机 shell 导出的真实库；护栏必须挡住它。 */
const AMBIENT = '/data/home/yale/.cloudcli/auth.db';

/** @param {string[]} argv */
function runCli(argv, extraEnv = {}) {
  return spawnSync(process.execPath, [SCRIPT, ...argv], {
    encoding: 'utf8',
    env: { ...process.env, DATABASE_PATH: AMBIENT, ...extraEnv },
  });
}

test('断言：缺省 --database-path 时拒绝运行', () => {
  assert.throws(
    () => assertIsolatedDatabasePath({ databasePath: undefined, ambientDatabasePath: AMBIENT }),
    (error) => error instanceof GuardRefusal && /必须显式给出临时 DATABASE_PATH/.test(error.message),
  );
});

test('断言：--database-path 等于 shell 导出的值时拒绝运行', () => {
  assert.throws(
    () => assertIsolatedDatabasePath({ databasePath: AMBIENT, ambientDatabasePath: AMBIENT }),
    (error) => error instanceof GuardRefusal && /真实库/.test(error.message),
  );
});

test('断言：--database-path 落在临时根之外时拒绝运行', () => {
  assert.throws(
    () => assertIsolatedDatabasePath({ databasePath: '/data/home/yale/work/claudecodeui/some.db', ambientDatabasePath: AMBIENT }),
    (error) => error instanceof GuardRefusal && /不在临时根/.test(error.message),
  );
});

test('断言：临时根下的路径被接受并解析为绝对路径', () => {
  const temp = path.join(os.tmpdir(), 'resident-guard-ok', 'auth.db');
  assert.strictEqual(assertIsolatedDatabasePath({ databasePath: temp, ambientDatabasePath: AMBIENT }), path.resolve(temp));
});

test('断言：受保护端口 3001 被拒', () => {
  assert.throws(() => assertSafePort(3001), (error) => error instanceof GuardRefusal);
  assert.doesNotThrow(() => assertSafePort(3123));
});

test('CLI：未显式给 --database-path 时 exit 1 且不写记录', () => {
  const result = runCli(['e1', '--seconds', '1']);
  assert.strictEqual(result.status, 1, `期望 exit 1，实际 ${result.status}；stdout=${result.stdout}`);
  assert.match(result.stderr, /必须显式给出临时 DATABASE_PATH/);
});

test('CLI：--database-path 指向真实库时 exit 1', () => {
  const result = runCli(['e1', '--database-path', AMBIENT, '--seconds', '1']);
  assert.strictEqual(result.status, 1, `期望 exit 1，实际 ${result.status}`);
  assert.match(result.stderr, /真实库/);
});

test('CLI：--check-record 对缺节记录 exit 1 并点名缺的小节', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'resident-record-missing-'));
  const file = path.join(dir, 'record.md');
  // 只写 E1，且 E1 缺 `结论：`；其余八节整个缺失。
  fs.writeFileSync(file, ['# 记录', '', '## E1 常驻 cron', '', '读数：', '```', 'pid=1', '```', ''].join('\n'));
  const result = runCli(['--check-record', file]);
  assert.strictEqual(result.status, 1, `期望 exit 1，实际 ${result.status}`);
  for (const id of ['E2', 'E3', 'E4', 'E5', 'E6', 'E7', 'E8', 'E9']) {
    assert.match(result.stderr, new RegExp(`${id}：缺整个小节`), `stderr 应点名 ${id}`);
  }
  assert.match(result.stderr, /E1：缺 `结论：` 行/, 'stderr 应点名 E1 缺结论行');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('CLI：--check-record 对缺 E9 节的记录 exit 1 并点名 E9', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'resident-record-no-e9-'));
  const file = path.join(dir, 'record.md');
  // 除 E9 外全齐（每节都有 `读数：`/`结论：`）。
  const sections = SECTION_IDS
    .filter((id) => id !== 'E9')
    .map((id) => `## ${id} 标题\n\n读数：\n\`\`\`\nraw\n\`\`\`\n结论：ok\n`);
  fs.writeFileSync(file, `# 记录\n\n${sections.join('\n')}`);
  const result = runCli(['--check-record', file]);
  assert.strictEqual(result.status, 1, `期望 exit 1，实际 ${result.status}；stdout=${result.stdout}`);
  assert.match(result.stderr, /E9：缺整个小节/, 'stderr 必须点名 E9');
  assert.doesNotMatch(result.stderr, /E1：/, 'E1 齐了，不该被点名');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('CLI：--check-record 对缺 E10 节的记录 exit 1 并点名 E10', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'resident-record-no-e10-'));
  const file = path.join(dir, 'record.md');
  // 除 E10 外全齐（每节都有 `读数：`/`结论：`）。
  const sections = SECTION_IDS
    .filter((id) => id !== 'E10')
    .map((id) => `## ${id} 标题\n\n读数：\n\`\`\`\nraw\n\`\`\`\n结论：ok\n`);
  fs.writeFileSync(file, `# 记录\n\n${sections.join('\n')}`);
  const result = runCli(['--check-record', file]);
  assert.strictEqual(result.status, 1, `期望 exit 1，实际 ${result.status}；stdout=${result.stdout}`);
  assert.match(result.stderr, /E10：缺整个小节/, 'stderr 必须点名 E10');
  assert.doesNotMatch(result.stderr, /E1：/, 'E1 齐了，不该被点名');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('CLI：--check-record 对十节齐全的记录 exit 0', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'resident-record-ok-'));
  const file = path.join(dir, 'record.md');
  const sections = SECTION_IDS.map((id) => `## ${id} 标题\n\n读数：\n\`\`\`\nraw\n\`\`\`\n结论：ok\n`);
  fs.writeFileSync(file, `# 记录\n\n${sections.join('\n')}`);
  const result = runCli(['--check-record', file]);
  assert.strictEqual(result.status, 0, `期望 exit 0，实际 ${result.status}；stderr=${result.stderr}`);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('纯函数：checkRecordText 逐节报告缺什么', () => {
  const missing = checkRecordText('## E1 x\n\n读数：\n结论：ok\n');
  assert.deepStrictEqual(missing.map((m) => m.id), ['E2', 'E3', 'E4', 'E5', 'E6', 'E7', 'E8', 'E9', 'E10']);
});

test('纯函数：checkRecordFile 对不存在的文件点名全部十节', () => {
  const missing = checkRecordFile('/tmp/definitely-not-here-resident.md');
  assert.deepStrictEqual(missing.map((m) => m.id), SECTION_IDS);
});

test('纯函数：extractSection 只取到下一个 `## ` 为止', () => {
  const text = '## E1 a\n\n读数：1\n结论：2\n\n## E2 b\n\n读数：3\n结论：4\n';
  assert.match(extractSection(text, 'E1') ?? '', /读数：1/);
  assert.doesNotMatch(extractSection(text, 'E1') ?? '', /读数：3/);
});

test('纯函数：upsertSection 重写同名小节而不留两份', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'resident-upsert-'));
  const file = path.join(dir, 'record.md');
  upsertSection(file, 'E1', '读数：\n```\nfirst\n```\n结论：一\n');
  upsertSection(file, 'E1', '读数：\n```\nsecond\n```\n结论：二\n');
  const text = fs.readFileSync(file, 'utf8');
  assert.strictEqual((text.match(/^##\s+E1\b/gm) ?? []).length, 1, 'E1 只应出现一次');
  assert.match(text, /second/);
  assert.doesNotMatch(text, /first/);
  fs.rmSync(dir, { recursive: true, force: true });
});
