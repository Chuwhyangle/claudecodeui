import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

// The service reads the registry through the shared port; evaluating the registry
// module is what installs that port (it is no longer a static dependency of the service).
import '@/modules/providers/provider.registry.js';
import { providerSkillsService } from '@/modules/providers/services/skills.service.js';

const patchHomeDir = (nextHomeDir: string) => {
  const original = os.homedir;
  (os as any).homedir = () => nextHomeDir;
  return () => {
    (os as any).homedir = original;
  };
};

const writeSkill = async (
  skillsRoot: string,
  directoryName: string,
  name: string,
  description: string,
): Promise<string> => {
  const skillDir = path.join(skillsRoot, directoryName);
  await fs.mkdir(skillDir, { recursive: true });
  const skillPath = path.join(skillDir, 'SKILL.md');
  await fs.writeFile(
    skillPath,
    `---\nname: ${name}\ndescription: ${description}\n---\n\n`,
    'utf8',
  );
  return skillPath;
};

const writeClaudePluginManifest = async (
  installPath: string,
  name: string,
): Promise<void> => {
  const pluginConfigDir = path.join(installPath, '.claude-plugin');
  await fs.mkdir(pluginConfigDir, { recursive: true });
  await fs.writeFile(
    path.join(pluginConfigDir, 'plugin.json'),
    JSON.stringify(
      {
        name,
        version: '0.1.0',
        description: `${name} test plugin`,
      },
      null,
      2,
    ),
    'utf8',
  );
};

const writeClaudePluginCommand = async (
  commandsRoot: string,
  commandName: string,
  description: string,
): Promise<string> => {
  await fs.mkdir(commandsRoot, { recursive: true });
  const commandPath = path.join(commandsRoot, `${commandName}.md`);
  await fs.writeFile(
    commandPath,
    `---\ndescription: ${description}\nargument-hint: 'test args'\n---\n\nCommand body.\n`,
    'utf8',
  );
  return commandPath;
};

/**
 * This test covers Claude user/project skill folders plus plugin discovery from
 * installed plugin command files and plugin skill files, including a plugin that
 * ships both.
 */
test('providerSkillsService lists claude user, project, and enabled plugin skills', { concurrency: false }, async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'llm-skills-claude-'));
  const workspacePath = path.join(tempRoot, 'workspace');
  const commandPluginInstallPath = path.join(
    tempRoot,
    '.claude',
    'plugins',
    'cache',
    'notion-plugin',
    'notion',
    'abc123',
  );
  const skillPluginInstallPath = path.join(
    tempRoot,
    '.claude',
    'plugins',
    'cache',
    'anthropic-agent-skills',
    'example-skills',
    'def456',
  );
  const disabledPluginInstallPath = path.join(
    tempRoot,
    '.claude',
    'plugins',
    'cache',
    'disabled-marketplace',
    'disabled-skills',
    'ghi789',
  );
  const emptyIdPluginInstallPath = path.join(
    tempRoot,
    '.claude',
    'plugins',
    'cache',
    'invalid-empty-plugin',
    'empty',
    '000',
  );
  const atIdPluginInstallPath = path.join(
    tempRoot,
    '.claude',
    'plugins',
    'cache',
    'invalid-at-plugin',
    'at',
    '000',
  );
  await fs.mkdir(workspacePath, { recursive: true });

  const restoreHomeDir = patchHomeDir(tempRoot);
  try {
    await writeSkill(
      path.join(tempRoot, '.claude', 'skills'),
      'claude-user-dir',
      'claude-user',
      'Claude user skill',
    );
    await writeSkill(
      path.join(workspacePath, '.claude', 'skills'),
      'claude-project-dir',
      'claude-project',
      'Claude project skill',
    );
    await writeClaudePluginManifest(commandPluginInstallPath, 'Notion');
    await writeClaudePluginCommand(
      path.join(commandPluginInstallPath, 'commands'),
      'insert-row',
      'Insert a Notion database row',
    );
    await writeSkill(
      path.join(commandPluginInstallPath, 'skills'),
      'command-plugin-skill-dir',
      'command-plugin-skill',
      'Skill shipped beside plugin commands',
    );
    await writeClaudePluginManifest(skillPluginInstallPath, 'ExampleSkills');
    // A commands folder holding nothing this reader takes must not hide the
    // skills beside it: plugins do ship commands in other agents' formats.
    await fs.mkdir(path.join(skillPluginInstallPath, 'commands'), { recursive: true });
    await fs.writeFile(
      path.join(skillPluginInstallPath, 'commands', 'other-agent.toml'),
      'description = "Command for another agent"\n',
      'utf8',
    );
    await writeSkill(
      path.join(skillPluginInstallPath, 'skills'),
      'claude-plugin-dir',
      'claude-plugin',
      'Claude plugin skill',
    );
    await writeSkill(
      path.join(skillPluginInstallPath, 'skills'),
      'claude-plugin-second-dir',
      'claude-plugin-second',
      'Second Claude plugin skill',
    );
    await writeSkill(
      path.join(skillPluginInstallPath, 'skills', 'nested', 'collection'),
      'claude-plugin-nested-dir',
      'claude-plugin-nested',
      'Nested Claude plugin skill',
    );
    await writeClaudePluginManifest(disabledPluginInstallPath, 'DisabledSkills');
    await writeClaudePluginCommand(
      path.join(disabledPluginInstallPath, 'commands'),
      'disabled-command',
      'Disabled plugin command',
    );
    await writeClaudePluginCommand(
      path.join(emptyIdPluginInstallPath, 'commands'),
      'invalid-empty-command',
      'Invalid empty id command',
    );
    await writeClaudePluginCommand(
      path.join(atIdPluginInstallPath, 'commands'),
      'invalid-at-command',
      'Invalid at id command',
    );
    await writeSkill(
      path.join(
        disabledPluginInstallPath,
        'skills',
      ),
      'disabled-plugin-dir',
      'disabled-plugin',
      'Disabled plugin skill',
    );

    await fs.writeFile(
      path.join(tempRoot, '.claude', 'settings.json'),
      JSON.stringify(
        {
          enabledPlugins: {
            '': true,
            '@': true,
            'notion@notion-marketplace': true,
            'example-skills@anthropic-agent-skills': true,
            'disabled-skills@disabled-marketplace': false,
          },
        },
        null,
        2,
      ),
      'utf8',
    );
    await fs.writeFile(
      path.join(tempRoot, '.claude', 'plugins', 'installed_plugins.json'),
      JSON.stringify(
        {
          version: 2,
          plugins: {
            '': [
              {
                scope: 'user',
                installPath: emptyIdPluginInstallPath,
                version: '000',
              },
            ],
            '@': [
              {
                scope: 'user',
                installPath: atIdPluginInstallPath,
                version: '000',
              },
            ],
            'notion@notion-marketplace': [
              {
                scope: 'user',
                installPath: commandPluginInstallPath,
                version: 'abc123',
              },
            ],
            'example-skills@anthropic-agent-skills': [
              {
                scope: 'user',
                installPath: skillPluginInstallPath,
                version: 'def456',
              },
            ],
            'disabled-skills@disabled-marketplace': [
              {
                scope: 'user',
                installPath: disabledPluginInstallPath,
                version: 'ghi789',
              },
            ],
          },
        },
        null,
        2,
      ),
      'utf8',
    );

    const skills = await providerSkillsService.listProviderSkills('claude', { workspacePath });
    const byName = new Map(skills.map((skill) => [skill.name, skill]));

    assert.equal(byName.get('claude-user')?.scope, 'user');
    assert.equal(byName.get('claude-user')?.command, '/claude-user');
    assert.equal(byName.get('claude-project')?.scope, 'project');
    assert.equal(byName.get('claude-project')?.command, '/claude-project');

    const pluginCommand = byName.get('insert-row');
    assert.equal(pluginCommand?.scope, 'plugin');
    assert.equal(pluginCommand?.pluginName, 'Notion');
    assert.equal(pluginCommand?.pluginId, 'notion@notion-marketplace');
    assert.equal(pluginCommand?.command, '/Notion:insert-row');
    assert.equal(pluginCommand?.description, 'Insert a Notion database row');
    assert.match(pluginCommand?.sourcePath ?? '', /commands[\\/]insert-row\.md$/);
    // A plugin that ships commands keeps its skills: the CLI offers both, so
    // the menu lists both rather than letting the commands folder hide them.
    const commandPluginSkill = byName.get('command-plugin-skill');
    assert.equal(commandPluginSkill?.scope, 'plugin');
    assert.equal(commandPluginSkill?.pluginName, 'Notion');
    assert.equal(commandPluginSkill?.pluginId, 'notion@notion-marketplace');
    assert.equal(commandPluginSkill?.command, '/Notion:command-plugin-skill');
    assert.equal(commandPluginSkill?.description, 'Skill shipped beside plugin commands');

    const pluginSkill = byName.get('claude-plugin');
    assert.equal(pluginSkill?.scope, 'plugin');
    assert.equal(pluginSkill?.pluginName, 'ExampleSkills');
    assert.equal(pluginSkill?.pluginId, 'example-skills@anthropic-agent-skills');
    assert.equal(pluginSkill?.command, '/ExampleSkills:claude-plugin');
    assert.equal(pluginSkill?.description, 'Claude plugin skill');
    assert.match(
      pluginSkill?.sourcePath ?? '',
      /cache[\\/]anthropic-agent-skills[\\/]example-skills[\\/]def456[\\/]skills[\\/]/,
    );

    const secondPluginSkill = byName.get('claude-plugin-second');
    assert.equal(secondPluginSkill?.scope, 'plugin');
    assert.equal(secondPluginSkill?.command, '/ExampleSkills:claude-plugin-second');

    const nestedPluginSkill = byName.get('claude-plugin-nested');
    assert.equal(nestedPluginSkill?.scope, 'plugin');
    assert.equal(nestedPluginSkill?.command, '/ExampleSkills:claude-plugin-nested');
    assert.equal(nestedPluginSkill?.description, 'Nested Claude plugin skill');

    assert.equal(byName.has('disabled-command'), false);
    assert.equal(byName.has('disabled-plugin'), false);
    assert.equal(byName.has('invalid-empty-command'), false);
    assert.equal(byName.has('invalid-at-command'), false);
    assert.equal(skills.some((skill) => skill.command.startsWith('/:')), false);
  } finally {
    restoreHomeDir();
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

/**
 * Claude's plugin cache keeps every release directory side by side. Only the
 * version named by the install record is the installed plugin; an older cached
 * release must not contribute commands or skills (its old front matter once
 * produced ghost slash commands such as `/quay:quay-init`).
 */
test('providerSkillsService ignores cached plugin versions other than the installed one', { concurrency: false }, async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'llm-skills-claude-versions-'));
  const workspacePath = path.join(tempRoot, 'workspace');
  const pluginCacheRoot = path.join(
    tempRoot,
    '.claude',
    'plugins',
    'cache',
    'quay-marketplace',
    'quay',
  );
  const installedPluginPath = path.join(pluginCacheRoot, '0.31.1');
  const previousPluginPath = path.join(pluginCacheRoot, '0.30.0');
  await fs.mkdir(workspacePath, { recursive: true });

  const restoreHomeDir = patchHomeDir(tempRoot);
  try {
    await writeClaudePluginManifest(installedPluginPath, 'quay');
    await writeSkill(
      path.join(installedPluginPath, 'skills'),
      'init-dir',
      'init',
      'Initialize a workspace',
    );
    await writeClaudePluginManifest(previousPluginPath, 'quay');
    await writeSkill(
      path.join(previousPluginPath, 'skills'),
      'quay-init-dir',
      'quay-init',
      'Old workspace initializer name',
    );
    await writeClaudePluginCommand(
      path.join(previousPluginPath, 'commands'),
      'init',
      'Old workspace initializer command',
    );

    await fs.writeFile(
      path.join(tempRoot, '.claude', 'settings.json'),
      JSON.stringify({ enabledPlugins: { 'quay@quay-marketplace': true } }, null, 2),
      'utf8',
    );
    await fs.writeFile(
      path.join(tempRoot, '.claude', 'plugins', 'installed_plugins.json'),
      JSON.stringify(
        {
          version: 2,
          plugins: {
            'quay@quay-marketplace': [
              {
                scope: 'user',
                installPath: installedPluginPath,
                version: '0.31.1',
              },
            ],
          },
        },
        null,
        2,
      ),
      'utf8',
    );

    const skills = await providerSkillsService.listProviderSkills('claude', { workspacePath });

    assert.equal(skills.some((skill) => skill.name === 'quay-init'), false);
    const initCommands = skills.filter((skill) => skill.command === '/quay:init');
    assert.equal(initCommands.length, 1);
    assert.equal(
      initCommands[0]?.sourcePath.startsWith(`${installedPluginPath}${path.sep}`),
      true,
    );
    assert.equal(
      skills.some(
        (skill) =>
          skill.scope === 'plugin' &&
          skill.sourcePath.startsWith(`${previousPluginPath}${path.sep}`),
      ),
      false,
    );
  } finally {
    restoreHomeDir();
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

/**
 * Historical layouts point `installPath` at a folder that carries no plugin
 * payload, leaving the real payload in a sibling directory. That fallback must
 * still read unversioned siblings, while skipping cached release directories
 * that do not match the install record's version.
 */
test('providerSkillsService falls back to sibling payload folders without resurrecting cached versions', { concurrency: false }, async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'llm-skills-claude-siblings-'));
  const workspacePath = path.join(tempRoot, 'workspace');
  const pluginCacheRoot = path.join(
    tempRoot,
    '.claude',
    'plugins',
    'cache',
    'legacy-marketplace',
    'legacy-plugin',
  );
  const installPath = path.join(pluginCacheRoot, 'holder');
  const unversionedSiblingPath = path.join(pluginCacheRoot, 'legacy777');
  const staleVersionSiblingPath = path.join(pluginCacheRoot, '0.9.0');
  const matchingVersionSiblingPath = path.join(pluginCacheRoot, '0.31.1');
  await fs.mkdir(workspacePath, { recursive: true });

  const restoreHomeDir = patchHomeDir(tempRoot);
  try {
    await fs.mkdir(installPath, { recursive: true });
    await writeSkill(
      path.join(unversionedSiblingPath, 'skills'),
      'legacy-sibling-dir',
      'legacy-sibling-skill',
      'Skill in an unversioned sibling folder',
    );
    await writeSkill(
      path.join(staleVersionSiblingPath, 'skills'),
      'stale-version-dir',
      'stale-version-skill',
      'Skill in a different cached version',
    );
    await writeSkill(
      path.join(matchingVersionSiblingPath, 'skills'),
      'matching-version-dir',
      'matching-version-skill',
      'Skill in the installed version folder',
    );

    await fs.writeFile(
      path.join(tempRoot, '.claude', 'settings.json'),
      JSON.stringify({ enabledPlugins: { 'legacy-plugin@legacy-marketplace': true } }, null, 2),
      'utf8',
    );
    await fs.writeFile(
      path.join(tempRoot, '.claude', 'plugins', 'installed_plugins.json'),
      JSON.stringify(
        {
          version: 2,
          plugins: {
            'legacy-plugin@legacy-marketplace': [
              {
                scope: 'user',
                installPath,
                version: '0.31.1',
              },
            ],
          },
        },
        null,
        2,
      ),
      'utf8',
    );

    const skills = await providerSkillsService.listProviderSkills('claude', { workspacePath });
    const byName = new Map(skills.map((skill) => [skill.name, skill]));

    assert.equal(byName.get('legacy-sibling-skill')?.scope, 'plugin');
    assert.equal(byName.get('legacy-sibling-skill')?.pluginName, 'legacy-plugin');
    assert.equal(byName.get('matching-version-skill')?.scope, 'plugin');
    assert.equal(byName.has('stale-version-skill'), false);
  } finally {
    restoreHomeDir();
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

/**
 * This test covers Codex repository/user/system skill folders, including both
 * supported user roots, and verifies repository lookup across cwd, parent, and git root.
 */
test('providerSkillsService lists codex repository, user, and system skills', { concurrency: false }, async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'llm-skills-codex-'));
  const repoRoot = path.join(tempRoot, 'repo');
  const workspacePath = path.join(repoRoot, 'packages', 'app');
  await fs.mkdir(path.join(repoRoot, '.git'), { recursive: true });
  await fs.mkdir(workspacePath, { recursive: true });

  const restoreHomeDir = patchHomeDir(tempRoot);
  try {
    await writeSkill(
      path.join(workspacePath, '.agents', 'skills'),
      'codex-cwd-dir',
      'codex-cwd',
      'Codex cwd skill',
    );
    await writeSkill(
      path.join(repoRoot, 'packages', '.agents', 'skills'),
      'codex-parent-dir',
      'codex-parent',
      'Codex parent skill',
    );
    await writeSkill(
      path.join(repoRoot, '.agents', 'skills'),
      'codex-root-dir',
      'codex-root',
      'Codex root skill',
    );
    await writeSkill(
      path.join(tempRoot, '.agents', 'skills'),
      'codex-user-dir',
      'codex-user',
      'Codex user skill',
    );
    await writeSkill(
      path.join(tempRoot, '.codex', 'skills'),
      'codex-home-user-dir',
      'codex-home-user',
      'Codex home user skill',
    );
    await writeSkill(
      path.join(tempRoot, '.codex', 'skills', '.system'),
      'codex-system-dir',
      'codex-system',
      'Codex system skill',
    );

    const skills = await providerSkillsService.listProviderSkills('codex', { workspacePath });
    const byName = new Map(skills.map((skill) => [skill.name, skill]));

    assert.equal(byName.get('codex-cwd')?.scope, 'repo');
    assert.equal(byName.get('codex-parent')?.scope, 'repo');
    assert.equal(byName.get('codex-root')?.scope, 'repo');
    assert.equal(byName.get('codex-user')?.scope, 'user');
    assert.equal(byName.get('codex-home-user')?.scope, 'user');
    assert.equal(byName.get('codex-system')?.scope, 'system');
    assert.equal(byName.get('codex-root')?.command, '$codex-root');
  } finally {
    restoreHomeDir();
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

/**
 * This test covers OpenCode skill lookup across cwd-to-git-root project folders
 * plus the global OpenCode/Claude/Agents compatibility locations.
 */
test('providerSkillsService lists opencode project and user compatibility skills', { concurrency: false }, async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'llm-skills-opencode-'));
  const repoRoot = path.join(tempRoot, 'repo');
  const workspacePath = path.join(repoRoot, 'packages', 'app');
  await fs.mkdir(path.join(repoRoot, '.git'), { recursive: true });
  await fs.mkdir(workspacePath, { recursive: true });

  const restoreHomeDir = patchHomeDir(tempRoot);
  try {
    await writeSkill(
      path.join(workspacePath, '.opencode', 'skills'),
      'opencode-cwd-dir',
      'opencode-cwd',
      'OpenCode cwd skill',
    );
    await writeSkill(
      path.join(repoRoot, 'packages', '.claude', 'skills'),
      'opencode-claude-parent-dir',
      'opencode-claude-parent',
      'OpenCode Claude parent skill',
    );
    await writeSkill(
      path.join(repoRoot, '.agents', 'skills'),
      'opencode-agents-root-dir',
      'opencode-agents-root',
      'OpenCode Agents root skill',
    );
    await writeSkill(
      path.join(tempRoot, '.config', 'opencode', 'skills'),
      'opencode-user-dir',
      'opencode-user',
      'OpenCode user skill',
    );
    await writeSkill(
      path.join(tempRoot, '.claude', 'skills'),
      'opencode-claude-user-dir',
      'opencode-claude-user',
      'OpenCode Claude user skill',
    );
    await writeSkill(
      path.join(tempRoot, '.agents', 'skills'),
      'opencode-agents-user-dir',
      'opencode-agents-user',
      'OpenCode Agents user skill',
    );

    const skills = await providerSkillsService.listProviderSkills('opencode', { workspacePath });
    const byName = new Map(skills.map((skill) => [skill.name, skill]));

    assert.equal(byName.get('opencode-cwd')?.scope, 'project');
    assert.equal(byName.get('opencode-claude-parent')?.scope, 'project');
    assert.equal(byName.get('opencode-agents-root')?.scope, 'project');
    assert.equal(byName.get('opencode-user')?.scope, 'user');
    assert.equal(byName.get('opencode-claude-user')?.scope, 'user');
    assert.equal(byName.get('opencode-agents-user')?.scope, 'user');
    assert.equal(byName.get('opencode-cwd')?.command, '/opencode-cwd');
  } finally {
    restoreHomeDir();
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

/**
 * This test covers Cursor skill directory rules, including shared
 * `.agents/skills` project support.
 */
test('providerSkillsService lists cursor skills from its configured directories', { concurrency: false }, async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'llm-skills-gc-'));
  const workspacePath = path.join(tempRoot, 'workspace');
  await fs.mkdir(workspacePath, { recursive: true });

  const restoreHomeDir = patchHomeDir(tempRoot);
  try {
    await writeSkill(
      path.join(tempRoot, '.agents', 'skills'),
      'agents-user-dir',
      'agents-user',
      'Agents user skill',
    );
    await writeSkill(
      path.join(workspacePath, '.agents', 'skills'),
      'agents-project-dir',
      'agents-project',
      'Agents project skill',
    );
    await writeSkill(
      path.join(workspacePath, '.cursor', 'skills'),
      'cursor-project-dir',
      'cursor-project',
      'Cursor project skill',
    );
    await writeSkill(
      path.join(tempRoot, '.cursor', 'skills'),
      'cursor-user-dir',
      'cursor-user',
      'Cursor user skill',
    );

    const cursorSkills = await providerSkillsService.listProviderSkills('cursor', { workspacePath });
    const cursorByName = new Map(cursorSkills.map((skill) => [skill.name, skill]));
    assert.equal(cursorByName.get('agents-project')?.scope, 'project');
    assert.equal(cursorByName.get('cursor-project')?.scope, 'project');
    assert.equal(cursorByName.get('cursor-user')?.scope, 'user');
    assert.equal(cursorByName.get('cursor-user')?.command, '/cursor-user');
  } finally {
    restoreHomeDir();
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

/**
 * This test covers managed global skill creation for providers that own a
 * writable user skill directory.
 */
test('providerSkillsService adds global skills for claude, codex, and cursor', { concurrency: false }, async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'llm-skills-create-'));
  const restoreHomeDir = patchHomeDir(tempRoot);

  try {
    const createdClaudeSkills = await providerSkillsService.addProviderSkills('claude', {
      entries: [
        {
          directoryName: 'claude-global-dir',
          content: '---\nname: claude-global\ndescription: Claude global skill\n---\n\nClaude body.\n',
        },
      ],
    });
    const createdClaudeSkill = createdClaudeSkills[0];
    assert.ok(createdClaudeSkill);
    assert.equal(createdClaudeSkill.command, '/claude-global');
    assert.equal(
      createdClaudeSkill.sourcePath.endsWith(path.join('.claude', 'skills', 'claude-global-dir', 'SKILL.md')),
      true,
    );
    assert.match(
      await fs.readFile(createdClaudeSkill.sourcePath, 'utf8'),
      /Claude body\./,
    );

    const createdCodexSkills = await providerSkillsService.addProviderSkills('codex', {
      entries: [
        {
          directoryName: 'uploaded-codex-folder',
          fileName: 'SKILL.md',
          content: '---\nname: codex-global\ndescription: Codex global skill\n---\n\nCodex body.\n',
          files: [
            {
              relativePath: 'scripts/run.js',
              content: Buffer.from('console.log("codex skill");\n').toString('base64'),
              encoding: 'base64',
            },
          ],
        },
      ],
    });
    const createdCodexSkill = createdCodexSkills[0];
    assert.ok(createdCodexSkill);
    assert.equal(createdCodexSkill.command, '$codex-global');
    assert.equal(
      createdCodexSkill.sourcePath.endsWith(path.join('.agents', 'skills', 'uploaded-codex-folder', 'SKILL.md')),
      true,
    );
    assert.equal(
      await fs.readFile(path.join(path.dirname(createdCodexSkill.sourcePath), 'scripts', 'run.js'), 'utf8'),
      'console.log("codex skill");\n',
    );

    const fallbackNamedSkills = await providerSkillsService.addProviderSkills('codex', {
      entries: [
        {
          fileName: 'fallback / skill.md',
          content: '---\ndescription: Normalized fallback skill\n---\n\nFallback body.\n',
        },
      ],
    });
    const fallbackNamedSkill = fallbackNamedSkills[0];
    assert.ok(fallbackNamedSkill);
    assert.equal(fallbackNamedSkill.name, 'fallback-skill');
    assert.equal(fallbackNamedSkill.command, '$fallback-skill');
    assert.equal(
      fallbackNamedSkill.sourcePath.endsWith(path.join('.agents', 'skills', 'fallback-skill', 'SKILL.md')),
      true,
    );

    const replacedCodexSkills = await providerSkillsService.addProviderSkills('codex', {
      entries: [
        {
          directoryName: 'uploaded-codex-folder',
          content: '---\nname: replacement\ndescription: Replacement skill\n---\n\nReplacement body.\n',
        },
      ],
    });
    assert.equal(replacedCodexSkills[0]?.command, '$replacement');
    assert.match(await fs.readFile(createdCodexSkill.sourcePath, 'utf8'), /Replacement body\./);
    await assert.rejects(
      fs.stat(path.join(path.dirname(createdCodexSkill.sourcePath), 'scripts', 'run.js')),
      { code: 'ENOENT' },
    );

    const pendingBatchSkillPath = path.join(tempRoot, '.agents', 'skills', 'pending-batch', 'SKILL.md');
    await assert.rejects(
      providerSkillsService.addProviderSkills('codex', {
        entries: [
          {
            directoryName: 'pending-batch',
            content: '---\nname: pending-batch\n---\n\nPending body.\n',
          },
          {
            directoryName: 'pending-batch',
            content: '---\nname: duplicate-batch\n---\n\nDuplicate body.\n',
          },
        ],
      }),
      /duplicate skill target/i,
    );
    await assert.rejects(fs.stat(pendingBatchSkillPath), { code: 'ENOENT' });

    const createdCursorSkills = await providerSkillsService.addProviderSkills('cursor', {
      entries: [
        {
          directoryName: 'cursor-global-dir',
          content: '---\nname: cursor-global\ndescription: Cursor global skill\n---\n\nCursor body.\n',
        },
      ],
    });
    const createdCursorSkill = createdCursorSkills[0];
    assert.ok(createdCursorSkill);
    assert.equal(createdCursorSkill.command, '/cursor-global');
    assert.equal(
      createdCursorSkill.sourcePath.endsWith(path.join('.cursor', 'skills', 'cursor-global-dir', 'SKILL.md')),
      true,
    );

    const listedClaudeSkills = await providerSkillsService.listProviderSkills('claude');
    assert.equal(listedClaudeSkills.some((skill) => skill.name === 'claude-global'), true);

    const listedCodexSkills = await providerSkillsService.listProviderSkills('codex');
    assert.equal(listedCodexSkills.some((skill) => skill.name === 'replacement'), true);

    const listedCursorSkills = await providerSkillsService.listProviderSkills('cursor');
    assert.equal(listedCursorSkills.some((skill) => skill.name === 'cursor-global'), true);

    const removedCodexSkill = await providerSkillsService.removeProviderSkill('codex', {
      directoryName: 'uploaded-codex-folder',
    });
    assert.equal(removedCodexSkill.removed, true);
    assert.equal(removedCodexSkill.provider, 'codex');
    assert.equal(removedCodexSkill.directoryName, 'uploaded-codex-folder');
    await assert.rejects(fs.stat(path.dirname(createdCodexSkill.sourcePath)), { code: 'ENOENT' });

    const removedMissingSkill = await providerSkillsService.removeProviderSkill('codex', {
      directoryName: 'uploaded-codex-folder',
    });
    assert.equal(removedMissingSkill.removed, false);

    await assert.rejects(
      providerSkillsService.addProviderSkills('codex', {
        entries: [
          {
            content: '---\nname: unsafe-skill\n---\n',
            files: [
              {
                relativePath: '../outside.js',
                content: '',
                encoding: 'utf8',
              },
            ],
          },
        ],
      }),
      /invalid supporting file path/i,
    );
  } finally {
    restoreHomeDir();
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

/**
 * OpenCode reuses other providers' skill folders, so it should not accept
 * direct skill writes through the managed provider endpoint.
 */
test('providerSkillsService rejects managed skill creation for opencode', { concurrency: false }, async () => {
  await assert.rejects(
    providerSkillsService.addProviderSkills('opencode', {
      entries: [
        {
          directoryName: 'opencode-global-dir',
          content: '---\nname: opencode-global\ndescription: Unsupported skill\n---\n\nOpenCode body.\n',
        },
      ],
    }),
    /does not support managed global skills/i,
  );

  await assert.rejects(
    providerSkillsService.removeProviderSkill('opencode', {
      directoryName: 'opencode-global-dir',
    }),
    /does not support managed global skills/i,
  );
});

const writeClaudePluginRegistry = async (
  claudeHomePath: string,
  plugins: Record<string, Array<Record<string, unknown>>>,
): Promise<void> => {
  const pluginsRoot = path.join(claudeHomePath, 'plugins');
  await fs.mkdir(pluginsRoot, { recursive: true });
  await fs.writeFile(
    path.join(pluginsRoot, 'installed_plugins.json'),
    JSON.stringify({ version: 2, plugins }, null, 2),
    'utf8',
  );
};

const writeClaudeEnabledPlugins = async (
  settingsPath: string,
  enabledPlugins: Record<string, boolean>,
): Promise<void> => {
  await fs.mkdir(path.dirname(settingsPath), { recursive: true });
  await fs.writeFile(settingsPath, JSON.stringify({ enabledPlugins }, null, 2), 'utf8');
};

/**
 * A plugin registry can carry one record per install scope, and the cache keeps every release.
 * A `local`/`project` record belongs to the project named by its `projectPath`: an install made
 * for another workspace (a `local` archguard release, say) must not contribute skills here,
 * while a record whose `projectPath` is this workspace does.
 */
test('providerSkillsService ignores plugin install records scoped to another project', { concurrency: false }, async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'llm-skills-claude-scope-'));
  const workspacePath = path.join(tempRoot, 'workspace');
  const otherProjectPath = path.join(tempRoot, 'other-project');
  const pluginCacheRoot = path.join(
    tempRoot,
    '.claude',
    'plugins',
    'cache',
    'archguard-marketplace',
    'archguard',
  );
  const foreignLocalInstallPath = path.join(pluginCacheRoot, '0.1.42');
  const workspaceProjectInstallPath = path.join(pluginCacheRoot, '0.1.44');
  const foreignOnlyInstallPath = path.join(pluginCacheRoot, 'foreign-only', '0.1.40');
  await fs.mkdir(workspacePath, { recursive: true });
  await fs.mkdir(otherProjectPath, { recursive: true });

  const restoreHomeDir = patchHomeDir(tempRoot);
  try {
    await writeClaudePluginManifest(foreignLocalInstallPath, 'archguard');
    await writeClaudePluginCommand(
      path.join(foreignLocalInstallPath, 'commands'),
      'foreign-local-command',
      'Command from another project\'s local install',
    );
    await writeClaudePluginManifest(workspaceProjectInstallPath, 'archguard');
    await writeClaudePluginCommand(
      path.join(workspaceProjectInstallPath, 'commands'),
      'workspace-command',
      'Command from this workspace\'s project install',
    );
    await writeClaudePluginManifest(foreignOnlyInstallPath, 'foreign-only');
    await writeClaudePluginCommand(
      path.join(foreignOnlyInstallPath, 'commands'),
      'foreign-only-command',
      'Command from a plugin installed only for another project',
    );

    await writeClaudeEnabledPlugins(
      path.join(tempRoot, '.claude', 'settings.json'),
      {
        'archguard@archguard-marketplace': true,
        'foreign-only@foreign-marketplace': true,
      },
    );
    await writeClaudePluginRegistry(path.join(tempRoot, '.claude'), {
      'archguard@archguard-marketplace': [
        {
          scope: 'local',
          projectPath: otherProjectPath,
          installPath: foreignLocalInstallPath,
          version: '0.1.42',
          lastUpdated: '2026-10-21T15:48:17.355Z',
        },
        {
          scope: 'project',
          projectPath: workspacePath,
          installPath: workspaceProjectInstallPath,
          version: '0.1.44',
          lastUpdated: '2026-10-22T09:00:00.000Z',
        },
      ],
      'foreign-only@foreign-marketplace': [
        {
          scope: 'local',
          projectPath: otherProjectPath,
          installPath: foreignOnlyInstallPath,
          version: '0.1.40',
          lastUpdated: '2026-10-20T09:00:00.000Z',
        },
      ],
    });

    const skills = await providerSkillsService.listProviderSkills('claude', { workspacePath });
    const byName = new Map(skills.map((skill) => [skill.name, skill]));

    const workspaceCommand = byName.get('workspace-command');
    assert.equal(workspaceCommand?.scope, 'plugin');
    assert.equal(workspaceCommand?.command, '/archguard:workspace-command');
    assert.equal(
      workspaceCommand?.sourcePath.startsWith(`${workspaceProjectInstallPath}${path.sep}`),
      true,
    );

    assert.equal(byName.has('foreign-local-command'), false);
    assert.equal(byName.has('foreign-only-command'), false);
    assert.equal(
      skills.some(
        (skill) =>
          skill.scope === 'plugin'
          && skill.sourcePath.startsWith(`${foreignLocalInstallPath}${path.sep}`),
      ),
      false,
    );
  } finally {
    restoreHomeDir();
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

/**
 * One plugin with both a `user` and a `project` (this workspace) enabled record must be listed
 * from the project record only: the higher priority record IS the installed plugin, and reading
 * the lower one as well duplicates every command in the menu.
 */
test('providerSkillsService lists a plugin from its highest-priority applicable record once', { concurrency: false }, async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'llm-skills-claude-priority-'));
  const workspacePath = path.join(tempRoot, 'workspace');
  const pluginCacheRoot = path.join(
    tempRoot,
    '.claude',
    'plugins',
    'cache',
    'archguard-marketplace',
    'archguard',
  );
  const userInstallPath = path.join(pluginCacheRoot, '0.1.44');
  const projectInstallPath = path.join(pluginCacheRoot, '0.1.45');
  await fs.mkdir(workspacePath, { recursive: true });

  const restoreHomeDir = patchHomeDir(tempRoot);
  try {
    for (const installPath of [userInstallPath, projectInstallPath]) {
      await writeClaudePluginManifest(installPath, 'archguard');
      await writeClaudePluginCommand(
        path.join(installPath, 'commands'),
        'inspect',
        `Inspect command from ${path.basename(installPath)}`,
      );
      await writeClaudePluginCommand(
        path.join(installPath, 'commands'),
        'status',
        `Status command from ${path.basename(installPath)}`,
      );
    }

    await writeClaudeEnabledPlugins(
      path.join(tempRoot, '.claude', 'settings.json'),
      { 'archguard@archguard-marketplace': true },
    );
    await writeClaudePluginRegistry(path.join(tempRoot, '.claude'), {
      'archguard@archguard-marketplace': [
        {
          scope: 'user',
          installPath: userInstallPath,
          version: '0.1.44',
          lastUpdated: '2026-11-06T02:17:59.353Z',
        },
        {
          scope: 'project',
          projectPath: workspacePath,
          installPath: projectInstallPath,
          version: '0.1.45',
          lastUpdated: '2026-10-20T02:17:59.353Z',
        },
      ],
    });

    const skills = await providerSkillsService.listProviderSkills('claude', { workspacePath });

    for (const commandName of ['inspect', 'status']) {
      const matching = skills.filter((skill) => skill.command === `/archguard:${commandName}`);
      assert.equal(matching.length, 1, `${commandName} must be listed exactly once`);
      assert.equal(
        matching[0]?.sourcePath.startsWith(`${projectInstallPath}${path.sep}`),
        true,
        `${commandName} must come from the higher-priority project record`,
      );
    }
    assert.equal(
      skills.some(
        (skill) =>
          skill.scope === 'plugin'
          && skill.sourcePath.startsWith(`${userInstallPath}${path.sep}`),
      ),
      false,
    );
  } finally {
    restoreHomeDir();
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

/**
 * `enabledPlugins` is a per-scope switch with Claude's precedence: the user settings can enable
 * a plugin while this workspace's `.claude/settings.json` disables its project scope, and a
 * plugin no settings file mentions is enabled by default.
 */
test('providerSkillsService applies enabledPlugins precedence per plugin scope', { concurrency: false }, async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'llm-skills-claude-enabled-'));
  const workspacePath = path.join(tempRoot, 'workspace');
  const pluginCacheRoot = path.join(
    tempRoot,
    '.claude',
    'plugins',
    'cache',
    'precedence-marketplace',
  );
  const projectInstallPath = path.join(pluginCacheRoot, 'precedence-plugin', '0.1.0');
  const unconfiguredInstallPath = path.join(pluginCacheRoot, 'unconfigured-plugin', '0.2.0');
  await fs.mkdir(workspacePath, { recursive: true });

  const restoreHomeDir = patchHomeDir(tempRoot);
  try {
    await writeClaudePluginManifest(projectInstallPath, 'precedence-plugin');
    await writeClaudePluginCommand(
      path.join(projectInstallPath, 'commands'),
      'disabled-by-workspace',
      'Command whose project scope the workspace disabled',
    );
    await writeClaudePluginManifest(unconfiguredInstallPath, 'unconfigured-plugin');
    await writeClaudePluginCommand(
      path.join(unconfiguredInstallPath, 'commands'),
      'enabled-by-default',
      'Command from a plugin no settings file mentions',
    );

    await writeClaudeEnabledPlugins(
      path.join(tempRoot, '.claude', 'settings.json'),
      { 'precedence-plugin@precedence-marketplace': true },
    );
    await writeClaudeEnabledPlugins(
      path.join(workspacePath, '.claude', 'settings.json'),
      { 'precedence-plugin@precedence-marketplace': false },
    );
    await writeClaudePluginRegistry(path.join(tempRoot, '.claude'), {
      'precedence-plugin@precedence-marketplace': [
        {
          scope: 'project',
          projectPath: workspacePath,
          installPath: projectInstallPath,
          version: '0.1.0',
          lastUpdated: '2026-10-20T02:17:59.353Z',
        },
      ],
      'unconfigured-plugin@precedence-marketplace': [
        {
          scope: 'user',
          installPath: unconfiguredInstallPath,
          version: '0.2.0',
          lastUpdated: '2026-10-20T02:17:59.353Z',
        },
      ],
    });

    const skills = await providerSkillsService.listProviderSkills('claude', { workspacePath });
    const byName = new Map(skills.map((skill) => [skill.name, skill]));

    assert.equal(byName.has('disabled-by-workspace'), false);
    assert.equal(byName.get('enabled-by-default')?.scope, 'plugin');
    assert.equal(
      byName.get('enabled-by-default')?.sourcePath.startsWith(`${unconfiguredInstallPath}${path.sep}`),
      true,
    );
  } finally {
    restoreHomeDir();
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});
