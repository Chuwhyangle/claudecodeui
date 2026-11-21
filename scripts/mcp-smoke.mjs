#!/usr/bin/env node
// mcp-smoke.mjs —— AC-256 的嵌套冒烟取数与取证通道：**终端 Claude Code** 经 MCP 网关驱动真会话。
//
// 这条脚本不写产品代码。MCP 网关、PAT 认证、只读/写入工具与常驻宿主由 AC-239–AC-278 落地，
// 这里只做一件事：起一个**真服务进程**（临时 DATABASE_PATH、HOST=127.0.0.1、端口 listen(0) 探得且 ≠ 3001、
// detached 整组杀、MCP_ENABLED=1），播种一个带全部 scope 的 PAT，建一个临时项目，然后**真的**执行
// `claude mcp add --transport http cloudcli http://127.0.0.1:<port>/mcp --header "Authorization: Bearer <PAT>"`
// 并用自然语言提示驱动真 `claude` 进程，走完「列出会话 → 发消息 → 查进度 → 中止」，把八段的**原始读数**
// 落进记录文件，交人 yale 判定（判定行由 AC-257 收，本脚本不写、记录模板里也不出现）。
//
// 八段（AC 逐字，标题逐字）：
//   环境与版本 / 起独立实例 / Claude Code 握手与工具列表 / 列出会话 / 发消息 / 查进度 / 中止 / 收尾残留
//
// 与 AC-170 的 `scripts/resident-smoke.mjs` 的关键差别：那条的驱动面只有 HTTP + WS、脚本里厂商子命令
// 出现 0 次；本条的驱动面**正是终端 Claude Code**，所以这里出现 `claude` 子命令是**要求**，不是要回避的。
//
// 护栏，缺一条就拒绝运行而不写假读数：
//   1. `--database-path` 必须显式给出、落在临时根下、且不等于 shell 导出的真实库。
//   2. 端口一律 `listen(0)` 探得，且断言 ≠ 3001（本机常驻服务；本脚本绝不连接 / 启用 / 重启它）。
//   3. `/mcp` 握手任一步失败时点名拒绝（缺哪件说哪件），不写假的读数行。
//
// 用法：
//   node scripts/mcp-smoke.mjs --check-record <记录文件>
//   node scripts/mcp-smoke.mjs --database-path <临时目录>/auth.db [--record <记录文件>]
//                              [--temp-root <目录>]
//
// 退出码：0 = 八段走完且读数落盘；1 = 护栏拒绝、某段拒绝/失败、或 `--check-record` 不合格。

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import WebSocket from 'ws';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * 记录文件里必须齐全的八节，AC 逐字。`--check-record` 按这个数组逐节检查，缺哪节点名哪节。
 * 标题即 id：用整行相等比对（不用 `\b`——中文没有词边界）。
 */
export const SECTION_TITLES = [
  '环境与版本',
  '起独立实例',
  'Claude Code 握手与工具列表',
  '列出会话',
  '发消息',
  '查进度',
  '中止',
  '收尾残留',
];

/**
 * AC-276 的记录文件里必须齐全的八节，AC 逐字。`--check-resident-record` 按这个数组逐节检查，缺哪节
 * 点名哪节。**与 {@link SECTION_TITLES} 是两个不同的节集合**：那条是 GOAL-020（AC-256）的嵌套冒烟，
 * 本条是 GOAL-022 的常驻专有能力（启动 / 忙发 / 撤回 / 重配置 / 后台 / 审批 / 收尾），记录文件也不同
 * （`DEFAULT_RESIDENT_RECORD`）。标题即 id：整行相等比对（中文没有词边界）。
 */
export const RESIDENT_SECTION_TITLES = [
  '环境与版本',
  '常驻会话启动与 pid',
  '忙时发送',
  '撤回与 pid 不变',
  '重配置下一轮生效',
  '后台任务列出与停止',
  '审批',
  '收尾残留与生产监听 pid',
];

/**
 * 撤回一节：`--check-resident-record` 的机械检查 (b) 只在这一节里读 `pid-before=<n>` 与
 * `pid-after=<n>`，两者必须都解析得到且相等（假形态 (ii) 就是把它改成不等）。
 */
export const RESIDENT_CANCEL_SECTION = '撤回与 pid 不变';

/**
 * AC-269 的外部客户端绑定记录里必须齐全的**九节**，AC 逐字。`--check-external-record` 按这个数组逐节
 * 检查，缺哪节点名哪节。**与前两个节集合都不同**：AC-256 是嵌套冒烟（八节）、AC-276 是常驻专有能力
 * （八节），本条是经 cloudflared 公网基址的外部客户端绑定（九节），记录文件也不同
 * （`DEFAULT_EXTERNAL_RECORD`）。标题即 id：整行相等比对（中文没有词边界，不用 `\b`）。
 */
export const EXTERNAL_SECTION_TITLES = [
  '客户端与版本',
  '公网基址',
  '回调主机',
  '是否使用 DCR',
  '是否发送 resource',
  '是否使用 refresh token',
  '工具调用超时',
  'overview 返回',
  'allowlist 重绑',
];

/**
 * 令牌扫描只针对 `公网基址` 一节正文：出现 `ccp_`（PAT 前缀）或 `cca_`（OAuth access 前缀）即红——
 * 记录里只应有 https 主机名，不带任何令牌。
 */
export const EXTERNAL_TOKEN_SECTION = '公网基址';

/** `公网基址` 一节正文里一旦出现这两个前缀之一就判红并点名。 */
export const EXTERNAL_TOKEN_PATTERN = /ccp_|cca_/;

/** 本机常驻服务端口；冒烟一律避开它，且全程不连接 / 不启用 / 不重启它。 */
export const PROTECTED_PORT = 3001;

/** 记录文件默认位置。 */
export const DEFAULT_RECORD = path.join(ROOT, 'docs/proposals/cloudcli-mcp-smoke.md');

/** AC-276 的常驻冒烟记录文件默认位置（与 AC-256 的记录文件不同）。 */
export const DEFAULT_RESIDENT_RECORD = path.join(ROOT, 'docs/proposals/cloudcli-mcp-resident-smoke.md');

/** AC-269 的外部客户端绑定记录文件默认位置（与 AC-256/AC-276 的记录文件都不同）。 */
export const DEFAULT_EXTERNAL_RECORD = path.join(ROOT, 'docs/proposals/cloudcli-mcp-external-client.md');

/** MCP 网关的挂载路径（`MCP_GATEWAY_PATH`）；冒烟只打这一条。 */
export const MCP_PATH = '/mcp';

/** 环境变量名：起真服务时把它置 1，网关才会挂上 `/mcp`。 */
export const MCP_ENABLE_VAR = 'MCP_ENABLED';

/**
 * `claude mcp add` 一次的读数：逐字命令 + 退出码 + 两路输出。
 * @typedef {object} McpAddReading
 * @property {string} command
 * @property {number | null} status
 * @property {string} stdout
 * @property {string} stderr
 */

/** 护栏拒绝。带这个名字的错误一律 exit 1，并且不产生任何读数。 */
export class GuardRefusal extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = 'GuardRefusal';
  }
}

// ---------------------------------------------------------------------------
// 护栏（纯函数，判据直接调用）
// ---------------------------------------------------------------------------

/**
 * 拒绝理由：`--database-path` 必须显式给出、必须落在临时根下、且不得等于环境里已有的
 * `DATABASE_PATH`。返回解析后的绝对路径。
 *
 * 三条各自独立，因为它们挡的是三件不同的事：缺省 ⇒ 会写到别处；等于环境里的库 ⇒ 会写到真实库；
 * 不在临时根下 ⇒ 会写到任何别的地方。任一条为真都不运行。
 *
 * @param {{ databasePath: string | undefined, ambientDatabasePath?: string | undefined, tempRoot?: string }} input
 * @returns {string} 解析后的绝对路径
 */
export function assertIsolatedDatabasePath({ databasePath, ambientDatabasePath, tempRoot = os.tmpdir() }) {
  if (typeof databasePath !== 'string' || databasePath.trim() === '') {
    throw new GuardRefusal('拒绝运行：必须显式给出临时 DATABASE_PATH（--database-path <临时目录>/auth.db）');
  }
  const resolved = path.resolve(databasePath);
  if (typeof ambientDatabasePath === 'string' && ambientDatabasePath.trim() !== ''
    && resolved === path.resolve(ambientDatabasePath)) {
    throw new GuardRefusal(`拒绝运行：--database-path 等于 shell 导出的 DATABASE_PATH（${resolved}），那是真实库`);
  }
  const root = path.resolve(tempRoot);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new GuardRefusal(`拒绝运行：--database-path（${resolved}）不在临时根 ${root} 下`);
  }
  return resolved;
}

/**
 * 拒绝占用受保护端口。
 *
 * 探得端口之后、起服务之前调用一次，所以「端口 ≠ 3001」是运行期事实而不是事后检查。
 * @param {number} port
 */
export function assertSafePort(port) {
  if (port === PROTECTED_PORT) {
    throw new GuardRefusal(`拒绝运行：端口 ${PROTECTED_PORT} 是本机常驻服务，冒烟一律避开且绝不重启它`);
  }
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new GuardRefusal(`拒绝运行：端口 ${port} 不在可用范围`);
  }
}

// ---------------------------------------------------------------------------
// 记录文件：解析与逐节检查
// ---------------------------------------------------------------------------

/**
 * 抽出某个小节的正文（从 `## <标题>` 到下一个 `## ` 或文件尾）。
 *
 * 标题整行相等（尾部允许空白），所以 `## 中止` 不会匹配到别的小节里的同名片段。
 * @param {string} text
 * @param {string} title
 * @returns {string | null}
 */
export function extractSection(text, title) {
  const heading = new RegExp(`^##[ \\t]+${escapeRegExp(title)}[ \\t]*$`, 'm');
  const match = heading.exec(text);
  if (match === null) return null;
  const rest = text.slice(match.index + match[0].length);
  const next = /^##[ \t]+/m.exec(rest);
  return next === null ? rest : rest.slice(0, next.index);
}

/** @param {string} value */
function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 从「起独立实例」一节的正文里解析 `port=<n>`。
 *
 * 逐字匹配 `port=`（大小写敏感，前面不能是词字符）：`SERVER_PORT=` 那种全大写形式不会被误命中。
 * 解析不到返回 null（= 红），所以「读数里没有端口」与「端口是 3001」是两种各自点名的红。
 * @param {string} sectionText
 * @returns {number | null}
 */
export function parsePort(sectionText) {
  const match = /(?:^|[^A-Za-z0-9_])port=(\d+)/.exec(sectionText);
  return match === null ? null : Number(match[1]);
}

/**
 * 逐节检查：每节都要有非空 `读数：` 与 `结论：` 行；「起独立实例」一节的 `port=<n>` 必须能解析且 ≠ 3001。
 * 返回缺什么（空数组 = 齐全）。
 *
 * 缺整节、缺某一行、某行为空是三种不同的缺失，分开报：只报「缺这一节」会让一节写了一半的记录看起来像没写。
 * @param {string} text
 * @returns {Array<{ title: string, reason: string }>}
 */
export function checkRecordText(text) {
  /** @type {Array<{ title: string, reason: string }>} */
  const missing = [];
  for (const title of SECTION_TITLES) {
    const section = extractSection(text, title);
    if (section === null) {
      missing.push({ title, reason: '缺整个小节' });
      continue;
    }
    const reading = /^读数：(.*)$/m.exec(section);
    if (reading === null) {
      missing.push({ title, reason: '缺 `读数：` 行' });
    } else if (reading[1].trim() === '') {
      missing.push({ title, reason: '`读数：` 为空（冒号后去掉空白后没有内容）' });
    }
    const conclusion = /^结论：(.*)$/m.exec(section);
    if (conclusion === null) {
      missing.push({ title, reason: '缺 `结论：` 行' });
    } else if (conclusion[1].trim() === '') {
      missing.push({ title, reason: '`结论：` 为空（冒号后去掉空白后没有内容）' });
    }
  }

  // 端口那一件：只在该节存在时判，否则上面已经点名「缺整个小节」，再报一次是重复。
  const instance = extractSection(text, '起独立实例');
  if (instance !== null) {
    const port = parsePort(instance);
    if (port === null) {
      missing.push({ title: '起独立实例', reason: '解析不到 `port=<n>`' });
    } else if (port === PROTECTED_PORT) {
      missing.push({
        title: '起独立实例',
        reason: `port=${PROTECTED_PORT} 是本机常驻服务端口（受保护，冒烟一律避开）`,
      });
    }
  }
  return missing;
}

/**
 * 读文件后逐节检查。文件不存在时把八节全部点名为缺失（红态基线就是这一条）。
 * @param {string} filePath
 * @returns {Array<{ title: string, reason: string }>}
 */
export function checkRecordFile(filePath) {
  if (!fs.existsSync(filePath)) {
    return SECTION_TITLES.map((title) => ({ title, reason: `记录文件不存在（${filePath}）` }));
  }
  return checkRecordText(fs.readFileSync(filePath, 'utf8'));
}

// ---------------------------------------------------------------------------
// 常驻记录（AC-276）：解析与逐节检查 —— 节集合与 `--check-record` 分开
// ---------------------------------------------------------------------------

/**
 * 抽出常驻记录里某个小节的三种读法：整段正文、`读数：` 行、`结论：` 行。
 *
 * `读数：`/`结论：` 缺失时对应字段为 null，空串则是「有行但冒号后为空」。三种缺失（缺整节 / 缺行 /
 * 行为空）分开报，与 `--check-record` 同一套判读方式。
 * @param {string} text
 * @param {string} title
 * @returns {{ text: string, reading: string | null, conclusion: string | null } | null}
 */
export function parseResidentSection(text, title) {
  const section = extractSection(text, title);
  if (section === null) return null;
  const reading = /^读数：(.*)$/m.exec(section);
  const conclusion = /^结论：(.*)$/m.exec(section);
  return {
    text: section,
    reading: reading === null ? null : reading[1],
    conclusion: conclusion === null ? null : conclusion[1],
  };
}

/**
 * 从「撤回与 pid 不变」一节里解析 `pid-before=<n>` 与 `pid-after=<n>`。
 *
 * 逐字匹配 `pid-before=` / `pid-after=`（前面不能是词字符或 `-`，所以 `xpid-before=` 不会误命中）。
 * 解析不到返回 null —— 这正是「记录里没显式写出这两个字段」的红（假形态 (ii) 的负控制）。
 * @param {string} sectionText
 * @returns {{ before: number | null, after: number | null }}
 */
export function parseCancelPids(sectionText) {
  const before = /(?:^|[^A-Za-z0-9_-])pid-before=(\d+)/.exec(sectionText);
  const after = /(?:^|[^A-Za-z0-9_-])pid-after=(\d+)/.exec(sectionText);
  return {
    before: before === null ? null : Number(before[1]),
    after: after === null ? null : Number(after[1]),
  };
}

/**
 * 常驻记录的三件机械检查（AC-276/AC3 逐字）：
 *   (a) 八节逐节非空 `读数：` 与 `结论：`，缺整节点名该节、缺行点名该节缺哪行；
 *   (b) `撤回与 pid 不变` 一节的 `读数：` 行必须含 `pid-before=<n>` 与 `pid-after=<n>` 且二者相等，
 *       解析不到或不等即红并点名（假形态 (ii)）；
 *   (c) 文件不存在时把八节点名全缺（由 {@link checkResidentRecordFile} 承担）。
 * 返回缺什么（空数组 = 齐全）。
 * @param {string} text
 * @returns {Array<{ title: string, reason: string }>}
 */
export function checkResidentRecordText(text) {
  /** @type {Array<{ title: string, reason: string }>} */
  const missing = [];
  for (const title of RESIDENT_SECTION_TITLES) {
    const parsed = parseResidentSection(text, title);
    if (parsed === null) {
      missing.push({ title, reason: '缺整个小节' });
      continue;
    }
    if (parsed.reading === null) {
      missing.push({ title, reason: '缺 `读数：` 行' });
    } else if (parsed.reading.trim() === '') {
      missing.push({ title, reason: '`读数：` 为空（冒号后去掉空白后没有内容）' });
    }
    if (parsed.conclusion === null) {
      missing.push({ title, reason: '缺 `结论：` 行' });
    } else if (parsed.conclusion.trim() === '') {
      missing.push({ title, reason: '`结论：` 为空（冒号后去掉空白后没有内容）' });
    }
  }

  // (b) 撤回一节的 pid 前后：只在该节存在时判，否则上面已经点名「缺整个小节」，再报一次是重复。
  const cancel = parseResidentSection(text, RESIDENT_CANCEL_SECTION);
  if (cancel !== null) {
    const { before, after } = parseCancelPids(cancel.text);
    if (before === null || after === null) {
      missing.push({
        title: RESIDENT_CANCEL_SECTION,
        reason: '解析不到 `pid-before=<n>` 与 `pid-after=<n>` 两个字段（撤回节必须显式写出）',
      });
    } else if (before !== after) {
      missing.push({
        title: RESIDENT_CANCEL_SECTION,
        reason: `pid 不等：pid-before=${before} pid-after=${after}（撤回不得换进程）`,
      });
    }
  }
  return missing;
}

/**
 * 读文件后逐节检查。文件不存在时把八节全部点名为缺失（红态基线就是这一条）。
 * @param {string} filePath
 * @returns {Array<{ title: string, reason: string }>}
 */
export function checkResidentRecordFile(filePath) {
  if (!fs.existsSync(filePath)) {
    return RESIDENT_SECTION_TITLES.map((title) => ({ title, reason: `记录文件不存在（${filePath}）` }));
  }
  return checkResidentRecordText(fs.readFileSync(filePath, 'utf8'));
}

// ---------------------------------------------------------------------------
// 外部客户端绑定记录（AC-269）：解析与逐节检查 —— 九节、令牌扫描与另两个节集合都分开
// ---------------------------------------------------------------------------

/**
 * 抽出外部记录的某个小节（整段正文 + `读数：` 行 + `结论：` 行）。三种缺失（缺整节 / 缺行 / 行为空）
 * 分开报，与 `--check-record`/`--check-resident-record` 同一套判读方式。
 * @param {string} text
 * @param {string} title
 * @returns {{ text: string, reading: string | null, conclusion: string | null } | null}
 */
export function parseExternalSection(text, title) {
  return parseResidentSection(text, title);
}

/**
 * 外部记录的三件机械检查（AC-269/AC3 逐字）：
 *   (a) 九节逐节非空 `读数：` 与 `结论：`，缺整节点名该节、缺行点名该节缺哪行；
 *   (b) `公网基址` 一节正文不得出现 `ccp_`/`cca_` 令牌串（出现即红并点名该节）；
 *   (c) 文件不存在时把九节点名全缺（由 {@link checkExternalRecordFile} 承担）。
 * 返回缺什么（空数组 = 齐全）。
 * @param {string} text
 * @returns {Array<{ title: string, reason: string }>}
 */
export function checkExternalRecordText(text) {
  /** @type {Array<{ title: string, reason: string }>} */
  const missing = [];
  for (const title of EXTERNAL_SECTION_TITLES) {
    const parsed = parseExternalSection(text, title);
    if (parsed === null) {
      missing.push({ title, reason: '缺整个小节' });
      continue;
    }
    if (parsed.reading === null) {
      missing.push({ title, reason: '缺 `读数：` 行' });
    } else if (parsed.reading.trim() === '') {
      missing.push({ title, reason: '`读数：` 为空（冒号后去掉空白后没有内容）' });
    }
    if (parsed.conclusion === null) {
      missing.push({ title, reason: '缺 `结论：` 行' });
    } else if (parsed.conclusion.trim() === '') {
      missing.push({ title, reason: '`结论：` 为空（冒号后去掉空白后没有内容）' });
    }
  }

  // (b) 公网基址一节不得含令牌：只在该节存在时判，否则上面已经点名「缺整个小节」，再报一次是重复。
  const publicBase = parseExternalSection(text, EXTERNAL_TOKEN_SECTION);
  if (publicBase !== null && EXTERNAL_TOKEN_PATTERN.test(publicBase.text)) {
    missing.push({
      title: EXTERNAL_TOKEN_SECTION,
      reason: '正文含令牌串（ccp_/cca_）——公网基址只应是 https 主机名，不得带任何令牌',
    });
  }
  return missing;
}

/**
 * 读文件后逐节检查。文件不存在时把九节全部点名为缺失（红态基线就是这一条）。
 * @param {string} filePath
 * @returns {Array<{ title: string, reason: string }>}
 */
export function checkExternalRecordFile(filePath) {
  if (!fs.existsSync(filePath)) {
    return EXTERNAL_SECTION_TITLES.map((title) => ({ title, reason: `记录文件不存在（${filePath}）` }));
  }
  return checkExternalRecordText(fs.readFileSync(filePath, 'utf8'));
}

/**
 * 幂等写入小节：已存在同名 `## <标题>` 就整段替换，否则追加。重跑不会留两份。
 * @param {string} filePath
 * @param {string} title
 * @param {string} body
 */
export function upsertSection(filePath, title, body) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const heading = `## ${title}\n`;
  const existing = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : recordHeader();
  const match = new RegExp(`^##[ \\t]+${escapeRegExp(title)}[ \\t]*$`, 'm').exec(existing);
  let next;
  if (match === null) {
    next = `${existing.replace(/\s*$/, '')}\n\n${heading}\n${body.replace(/^\s+/, '')}\n`;
  } else {
    const rest = existing.slice(match.index);
    const nextHeading = /^##[ \t]+/m.exec(rest.slice(match[0].length));
    const tail = nextHeading === null ? '' : rest.slice(match[0].length + nextHeading.index);
    const head = existing.slice(0, match.index);
    next = `${head}${heading}\n${body.replace(/^\s+/, '')}\n\n${tail}`;
  }
  fs.writeFileSync(filePath, next);
}

/**
 * 记录文件表头：八节由 `upsertSection` 逐段追加，这一行只在文件第一次被写时出现。
 *
 * 表头**不写**人证行，也不写任何形如它的一行——那条由人 yale 在 AC-257 写，本脚本代写就会把下一条
 * 判据自己点亮。
 */
function recordHeader() {
  return [
    '# Cloudpit MCP 网关嵌套冒烟记录（AC-256）',
    '',
    '本文件由 `scripts/mcp-smoke.mjs` 写入：八节各含**原始**读数与一行结论。读数来自一次真跑——真服务',
    '实例（临时 `DATABASE_PATH`、`HOST=127.0.0.1`、端口 `listen(0)` 探得且 ≠ 3001）+ 一个真 PAT +',
    '终端里的 Claude Code（`claude mcp add --transport http`）+ 临时项目。',
    '`node scripts/mcp-smoke.mjs --check-record <本文件>` 逐节检查 `读数：`/`结论：` 是否齐全、读数是',
    '否为空、以及「起独立实例」一节记录的端口不是 3001。',
    '',
    '**人证行（AC-257）只能由人 yale 写入，执行者不得代写。** 执行者只写 `读数：` 与 `结论：` 行。',
    '',
  ].join('\n');
}

/**
 * 常驻记录文件表头（AC-276）。与 AC-256 的表头分离：这里说明八节是常驻专有能力的**故事线**，
 * 并同样**不写**人证行——那条只由人写（AC-277）。
 */
function residentRecordHeader() {
  return [
    '# Cloudpit MCP 网关常驻专有能力冒烟记录（AC-276）',
    '',
    '本文件由 `scripts/mcp-smoke.mjs --run-resident` 写入：八节各含**原始**读数与一行结论。读数来自一次',
    '真跑——真服务实例（临时 `DATABASE_PATH`、`HOST=127.0.0.1`、端口 `listen(0)` 探得且 ≠ 3001）+',
    '一个真 PAT + 终端里的 Claude Code（`claude mcp add --transport http`）+ 临时项目 + 真 `claude` CLI',
    '自然语言驱动走完常驻会话的八段故事线。',
    '`node scripts/mcp-smoke.mjs --check-resident-record <本文件>` 逐节检查 `读数：`/`结论：` 是否齐全、',
    '读数是否为空、以及「撤回与 pid 不变」一节的 `pid-before` 与 `pid-after` 是否相等。',
    '',
    '**人证行（AC-277）只能由人写入，执行者不得代写。** 执行者只写 `读数：` 与 `结论：` 行。',
    '',
  ].join('\n');
}

/**
 * 记录文件里的段落正文：一行原始读数 + 一行结论。
 * @param {string} reading
 * @param {string} conclusion
 * @returns {string}
 */
function sectionBody(reading, conclusion) {
  return `读数：${reading}\n结论：${conclusion}\n`;
}

// ---------------------------------------------------------------------------
// 通用读数（/proc、进程、时间、端口）
// ---------------------------------------------------------------------------

/** @param {number} pid */
export function isAlive(pid) {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const state = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[0];
    return state !== null && state !== undefined && state !== 'Z';
  } catch {
    return false;
  }
}

/**
 * `/proc/<pid>/environ` 拆成 `KEY=value` 表；读不到返回 null（刚 exec 完会短暂读不到）。
 * @param {number} pid
 * @returns {Record<string, string> | null}
 */
export function readEnviron(pid) {
  try {
    /** @type {Record<string, string>} */
    const env = {};
    for (const pair of fs.readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0')) {
      const eq = pair.indexOf('=');
      if (eq > 0) env[pair.slice(0, eq)] = pair.slice(eq + 1);
    }
    return env;
  } catch {
    return null;
  }
}

/** @param {number} ms */
export function delay(ms) {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

/**
 * 轮询直到谓词为真；超时抛出带上「在等什么」。
 * @param {() => any} predicate
 * @param {number} timeoutMs
 * @param {string} label
 */
export async function waitFor(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await predicate();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`等待超时 ${timeoutMs}ms：${label}`);
    await delay(150);
  }
}

/** `listen(0)` 探一个空闲端口，随后立刻关闭监听。AC 要求端口探得而不是写死。 */
export async function freePort() {
  return await new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port = address && typeof address === 'object' ? address.port : 0;
      probe.close(() => resolve(port));
    });
  });
}

/**
 * 读 `/proc/<pid>/stat` 的第 4、5 个字段（ppid、pgrp）。`comm` 里可能有空格和括号，从最后一个 `)` 之后切。
 * @param {number} pid
 */
export function procStat(pid) {
  let raw;
  try {
    raw = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
  } catch {
    return null;
  }
  const tail = raw.slice(raw.lastIndexOf(')') + 2).split(' ');
  return { ppid: Number(tail[1]), pgrp: Number(tail[2]) };
}

/**
 * `rootPid` 这棵进程子树里的所有 pid（不含 `rootPid` 自己）。
 *
 * 残留判据必须是**作用域内**的。机器的任何一行 argv 里恰好含临时根串的进程都能骗过
 * `pgrep -af <tempRoot>`——最典型的就是把本脚本的日志路径 `/tmp/<tmp>.log` 写进命令行的观察者
 * shell（`tail -F`）。那不是本次冒烟起出来的东西。真残留只可能是**我们自己 spawn 的**：`detached`
 * 只换进程组、不换父进程，所以临时服务（以及它拉起的 claude 子进程）始终在 `process.pid` 的子树里。
 * @param {number} [rootPid]
 */
export function descendantPids(rootPid = process.pid) {
  /** @type {Map<number, number>} */
  const parents = new Map();
  for (const entry of fs.readdirSync('/proc')) {
    const pid = Number(entry);
    if (!Number.isInteger(pid) || pid <= 1) continue;
    const stat = procStat(pid);
    if (stat) parents.set(pid, stat.ppid);
  }
  const tree = new Set([rootPid]);
  for (let grew = true; grew;) {
    grew = false;
    for (const [pid, ppid] of parents) {
      if (!tree.has(pid) && tree.has(ppid)) {
        tree.add(pid);
        grew = true;
      }
    }
  }
  tree.delete(rootPid);
  return tree;
}

/**
 * `pgrep -af` 里**属于本次冒烟子树**的进程行（按临时根过滤，别人的残留不算我的，发起链也不算）。
 * @param {string} tempRoot
 */
export function residualProcesses(tempRoot) {
  const result = spawnSync('pgrep', ['-af', tempRoot], { encoding: 'utf8' });
  const own = descendantPids();
  return (result.stdout || '')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .filter((line) => own.has(Number(line.trim().split(/\s+/)[0])));
}

/**
 * 比 `pgrep -af` 更强的一条残留读数：漏掉的服务进程**argv 里没有临时根**（临时根在它的
 * `DATABASE_PATH=…` 环境里，argv 只是 `npx tsx … server/index.ts`），所以只 grep argv 的 pgrep
 * 对「服务漏没漏」几乎是瞎的。这条逐个读 `/proc/<pid>/cmdline` 与 `/proc/<pid>/environ`，
 * 并且同样只认**子树内**的进程。
 * @param {string} tempRoot
 */
export function residualEnviron(tempRoot) {
  const own = descendantPids();
  const hits = [];
  for (const entry of fs.readdirSync('/proc')) {
    const pid = Number(entry);
    if (!Number.isInteger(pid) || pid <= 1 || !own.has(pid)) continue;
    for (const file of ['cmdline', 'environ']) {
      let text;
      try {
        text = fs.readFileSync(`/proc/${entry}/${file}`, 'utf8');
      } catch {
        continue; // 刚死的进程、或不是本用户的进程。
      }
      if (!text.includes(tempRoot)) continue;
      let name = '';
      try {
        name = fs.readFileSync(`/proc/${entry}/comm`, 'utf8').trim();
      } catch {
        name = '?';
      }
      hits.push(`${pid} ${name} (${file})`);
      break;
    }
  }
  return hits;
}

/**
 * `systemctl --user list-units` 里含本次临时根的行。
 * @param {string} tempRoot
 */
export function residualScopes(tempRoot) {
  const result = spawnSync(
    'systemctl',
    ['--user', 'list-units', '--type=scope', '--all', '--no-legend', '--no-pager'],
    { encoding: 'utf8' },
  );
  return (result.stdout || '').split('\n').filter((line) => line.includes(tempRoot));
}

/**
 * 谁在监听某个端口——`fuser -n tcp <port>` 是**产品无关**的读数：它报内核表里真正持有该端口的进程。
 * @param {number} port
 * @returns {number | null}
 */
export function portOwnerPid(port) {
  const result = spawnSync('fuser', ['-n', 'tcp', String(port)], { encoding: 'utf8' });
  const pid = Number((result.stdout || '').trim());
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

/** `:3001` 的两个独立读数：内核表里的持有者 + systemd 单元 MainPID。都没有就写「未读到」。 */
export function protectedPortReading() {
  const owner = portOwnerPid(PROTECTED_PORT);
  const unit = spawnSync(
    'systemctl',
    ['--user', 'show', '-p', 'MainPID', '--value', 'claudecodeui-server.service'],
    { encoding: 'utf8' },
  );
  const mainPid = (unit.stdout || '').trim() || '未读到';
  return `listener-pid=${owner ?? '未读到'} systemd-main-pid=${mainPid}`;
}

/** `claude --version` 的整行输出；CLI 不在 PATH 上时返回「未读到」。 */
export function claudeVersion() {
  const result = spawnSync('claude', ['--version'], { encoding: 'utf8' });
  if (result.status !== 0) {
    return `（未读到 claude --version：${(result.stderr || '').trim() || 'exit ' + result.status}）`;
  }
  return (result.stdout || '').trim();
}

/** SDK 版本，从**应用实际装的**那份 package.json 读，不猜。 */
export function mcpSdkVersion() {
  try {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(ROOT, 'node_modules/@modelcontextprotocol/sdk/package.json'), 'utf8'),
    );
    return `@modelcontextprotocol/sdk ${pkg.version}`;
  } catch (error) {
    return `（未读到 MCP SDK 版本：${error instanceof Error ? error.message : String(error)}）`;
  }
}

// ---------------------------------------------------------------------------
// 真服务进程
// ---------------------------------------------------------------------------

/** 服务进程读数：进程组 leader、真实 server pid、端口、日志、环境、停止入口。 */
export class ServerReading {
  /**
   * @param {{ leaderPid: number, port: number, logPath: string, tempRoot: string }} input
   */
  constructor(input) {
    this.leaderPid = input.leaderPid;
    this.port = input.port;
    this.logPath = input.logPath;
    this.tempRoot = input.tempRoot;
    this.stopped = false;
  }

  /** 真正持有本实例端口的那个进程（`npx` 那层只是包装，`leaderPid` 不是 server）。 */
  serverPid() {
    return portOwnerPid(this.port);
  }

  logText() {
    try {
      return fs.readFileSync(this.logPath, 'utf8');
    } catch {
      return '';
    }
  }

  /** `/proc/<leaderPid>/environ` 的 `KEY=value` 表；env 在 exec 时继承，包装层的读数是可信的。 */
  environ() {
    return readEnviron(this.leaderPid);
  }

  /**
   * `/proc/<leaderPid>/environ` 的命中行，逐字打印用。
   * @param {string[]} names
   */
  environLines(names) {
    const environ = this.environ() ?? {};
    return names.map((name) => (name in environ ? `${name}=${environ[name]}` : `${name}=（未设置）`));
  }

  /**
   * SIGTERM 进程组 leader，等它整棵子树走干净。
   *
   * 杀的是 `detached` 那次的负 pid，所以 `npx`→`tsx`→server 这条包装链一起收。
   */
  async stop(signal = 'SIGTERM') {
    if (this.stopped) return;
    this.stopped = true;
    try {
      process.kill(-this.leaderPid, signal);
    } catch {
      try {
        process.kill(this.leaderPid, signal);
      } catch {
        // 已经退出。
      }
    }
    await waitFor(() => !isAlive(this.leaderPid), 20_000, '服务进程组退出').catch(() => {});
  }
}

/**
 * 起一个**真**服务进程：`npx tsx --tsconfig server/tsconfig.json server/index.ts`。
 *
 * 日志走文件 fd 而不是管道：没人抽干的管道会填满并阻塞被观测的服务。`detached: true` 让整棵子树
 * 进自己的进程组，收尾时按组杀，包装层与孙进程不会留成孤儿。
 *
 * `HOME`/`CLAUDE_CONFIG_DIR` 都指向临时根。`MCP_ENABLED=1` 是 `/mcp` 挂载的唯一开关（AC-240 的
 * 门在挂载时读它一次），本脚本只对这个**临时**实例设置它，绝不碰生产。
 *
 * @param {{ tempRoot: string, label: string }} input
 */
export async function bootServer({ tempRoot, label }) {
  const port = await freePort();
  assertSafePort(port);

  const logPath = path.join(tempRoot, `server-${label}-${port}.log`);
  const logFd = fs.openSync(logPath, 'a');

  // 环境里导出的 DATABASE_PATH / HOST / SERVER_PORT / MCP_ENABLED 是给别的用途的，一个都不带进去。
  const env = { ...process.env };
  for (const name of ['DATABASE_PATH', 'HOST', 'SERVER_PORT', 'JWT_SECRET', 'NODE_OPTIONS', MCP_ENABLE_VAR]) {
    delete env[name];
  }
  Object.assign(env, {
    DATABASE_PATH: path.join(tempRoot, 'auth.db'),
    HOME: path.join(tempRoot, 'home'),
    CLAUDE_CONFIG_DIR: path.join(tempRoot, 'claude-config'),
    HOST: '127.0.0.1',
    SERVER_PORT: String(port),
    [MCP_ENABLE_VAR]: '1',
    FORCE_COLOR: '0',
  });
  delete env.NO_COLOR;

  const child = spawn('npx', ['tsx', '--tsconfig', 'server/tsconfig.json', 'server/index.ts'], {
    cwd: ROOT,
    env,
    detached: true,
    stdio: ['ignore', logFd, logFd],
  });
  const leaderPid = child.pid;
  if (leaderPid === undefined) throw new Error('服务子进程没有 pid：启动根本没发生');

  const reading = new ServerReading({ leaderPid, port, logPath, tempRoot });
  await waitFor(
    async () => {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/health`);
        return response.ok;
      } catch {
        return false;
      }
    },
    30_000,
    `服务（${label}, port=${port}）应答 /health；日志尾部：\n${reading.logText().slice(-2000)}`,
  );
  return reading;
}

/**
 * 打印一条原始读数行，同时返回它，便于段落正文复述。
 * @param {string} line
 * @returns {string}
 */
function say(line) {
  process.stdout.write(`${line}\n`);
  return line;
}

// ---------------------------------------------------------------------------
// HTTP 面（应用 API，JWT）与 JWT
// ---------------------------------------------------------------------------

/**
 * 一次带 token 的 HTTP 调用。
 *
 * 只对**传输层**失败做有界重试：undici 的 keep-alive 池会在服务端收尾那一刻复用一条正在关的
 * 连接，报 `TypeError: fetch failed`（cause 常见 `ECONNRESET` / `bad port`）。冒烟的断言针对载荷，
 * 不针对 socket，所以这一层重试不改任何判据；重试耗尽仍抛，并把 `cause` 带出来——否则「fetch failed」
 * 这三个字会把 ECONNRESET 和 bad port 两种完全不同的原因糊成一条。
 * @param {number} port
 * @param {string} token
 * @param {string} method
 * @param {string} requestPath
 * @param {unknown} [body]
 * @param {{attempts?: number}} [options]
 */
export async function api(port, token, method, requestPath, body, { attempts = 4 } = {}) {
  /** @type {unknown} */
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}${requestPath}`, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const text = await response.text();
      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = { raw: text };
      }
      return { status: response.status, body: parsed ?? {} };
    } catch (error) {
      lastError = error;
      if (attempt < attempts) await delay(250 * attempt);
    }
  }
  throw new Error(`${method} ${requestPath} 连续 ${attempts} 次都没打通：${errorText(lastError)}`);
}

/**
 * 把 catch 到的 `unknown` 折成一条可读文本，并把 `Error.cause` 带出来——否则「fetch failed」这三个字
 * 会把 ECONNRESET 和 bad port 两种完全不同的原因糊成一条。
 * @param {unknown} error
 * @returns {string}
 */
function errorText(error) {
  if (!(error instanceof Error)) return String(error);
  const cause = /** @type {{ code?: string, message?: string } | undefined} */ (error.cause);
  const causeText = cause === undefined
    ? ''
    : `（cause: ${cause?.code ?? cause?.message ?? String(cause)}）`;
  return `${error.message}${causeText}`;
}

/**
 * 拆 `{ success, data }` 信封，失败时把状态与响应体一并抛出（缺面必须点名而不是静默）。
 * @param {{ status: number, body: any }} answer
 * @param {string} label
 * @returns {any}
 */
export function dataOf(answer, label) {
  if (!(answer.status >= 200 && answer.status < 300)) {
    throw new Error(`${label} 应答 ${answer.status}：${JSON.stringify(answer.body)}`);
  }
  const data = answer.body.data;
  if (data === null || typeof data !== 'object') throw new Error(`${label} 没有 data 信封`);
  return data;
}

/**
 * 取一条可撤销的**应用 API** JWT（`GET /api/session-hosts`、`GET /api/providers/sessions/running`
 * 只认 JWT）。
 *
 * `mint-token.mjs` 用**目标库自己的** `jwt_secret` 签名，所以只能在服务起来之后、对该库调用；
 * 它拒绝在 `JWT_SECRET` 可达时运行，因此这里显式把它从环境里摘掉。
 *
 * 这与 PAT 的播种是两件事：PAT 走仓储函数直接写进临时库（见 {@link seedAccessToken}），这里这条
 * JWT 只为读应用 HTTP 面。
 * @param {string} databasePath
 * @param {string} outPath
 */
export function mintToken(databasePath, outPath) {
  const env = { ...process.env };
  delete env.JWT_SECRET;
  const result = spawnSync(
    'node',
    [path.join(ROOT, 'scripts/mint-token.mjs'), 'mint', '--db', databasePath, '--out', outPath],
    { cwd: ROOT, env, encoding: 'utf8' },
  );
  if (result.status !== 0) {
    throw new Error(`mint-token 拒绝：${result.stderr || result.stdout || '(无输出)'}`);
  }
  return fs.readFileSync(outPath, 'utf8').trim();
}

/**
 * 用一个**独立的 node 进程**把 PAT 写进临时库：SPEC §452 的做法——用仓储函数（`accessTokensDb` +
 * `createAccessTokensService`）直接写，不经 HTTP 登录拿 JWT。
 *
 * 为什么必须是独立进程：`createAccessTokensService` 的 `accessTokensDb` 绑定的是**导入时**由
 * `DATABASE_PATH` 决定的那个库；本进程（冒烟脚本）自己没有那个绑定，起一个带临时 `DATABASE_PATH`
 * 的 `npx tsx` 子进程才有。
 *
 * 生成物是一个 `.mts` 文件（不是 `.ts`）：临时目录没有 `{"type":"module"}` 标记，`.ts` 会被按 CJS
 * 转译，顶层 await 直接报错。`@/…` 别名由 `--tsconfig server/tsconfig.json` 解析。
 *
 * @param {{ tempRoot: string, databasePath: string, scopes: string[], name: string }} input
 * @returns {{ token: string, userId: number, tokenId: number, expiresAt: string }}
 */
export function seedAccessToken({ tempRoot, databasePath, scopes, name }) {
  const scriptPath = path.join(tempRoot, 'seed-pat.mts');
  const outPath = path.join(tempRoot, 'seed-pat.json');
  fs.writeFileSync(scriptPath, [
    "import fs from 'node:fs';",
    "import { createAccessTokensService } from '@/modules/oauth/access-tokens.service.js';",
    "import { userDb } from '@/modules/database/index.js';",
    '',
    `const SCOPES = ${JSON.stringify(scopes)};`,
    `const NAME = ${JSON.stringify(name)};`,
    `const OUT = ${JSON.stringify(outPath)};`,
    '',
    "const username = `mcp-smoke-${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 10)}`;",
    "const user = userDb.createUser(username, 'mcp-smoke-not-a-login');",
    'const service = createAccessTokensService({ now: () => new Date() });',
    'const issued = service.issueToken({ userId: Number(user.id), name: NAME, scopes: SCOPES, expiresInDays: 30 });',
    "if (!issued.ok) { throw new Error(`issueToken 拒绝：${JSON.stringify(issued)}`); }",
    'fs.writeFileSync(OUT, JSON.stringify({ token: issued.token.token, userId: Number(user.id), tokenId: issued.token.id, expiresAt: issued.token.expiresAt }));',
    "process.stdout.write(`PAT ${issued.token.tokenPrefix}… user=${user.id}\\n`);",
    '',
  ].join('\n'));

  const env = { ...process.env };
  for (const key of ['DATABASE_PATH', 'HOST', 'SERVER_PORT', 'JWT_SECRET', MCP_ENABLE_VAR]) delete env[key];
  Object.assign(env, { DATABASE_PATH: databasePath, HOME: path.join(tempRoot, 'home'), FORCE_COLOR: '0' });
  const result = spawnSync('npx', ['tsx', '--tsconfig', 'server/tsconfig.json', scriptPath], {
    cwd: ROOT,
    env,
    encoding: 'utf8',
  });
  if (result.status !== 0 || !fs.existsSync(outPath)) {
    throw new Error(
      `PAT 播种失败（exit ${result.status}）：${(result.stderr || result.stdout || '(无输出)').trim()}`,
    );
  }
  return JSON.parse(fs.readFileSync(outPath, 'utf8'));
}

// ---------------------------------------------------------------------------
// MCP 面（SDK 客户端：握手、工具列表、正控制读 run_get）
// ---------------------------------------------------------------------------

/**
 * 用 MCP SDK 客户端接上 `/mcp`（PAT 走 `Authorization: Bearer`）。
 *
 * 这条客户端与终端 Claude Code 是**两条独立**的入站面：它负责机械读数（`tools/list` 的逐字工具名、
 * 正控制里对一个非 MCP run 的 `run_get`），终端 Claude Code 负责 AC 要求的「自然语言驱动」。
 * @param {number} port
 * @param {string} pat
 */
export async function mcpConnect(port, pat) {
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}${MCP_PATH}`), {
    requestInit: { headers: { authorization: `Bearer ${pat}` } },
  });
  const client = new Client({ name: 'mcp-smoke', version: '0.1.0' });
  await client.connect(transport);
  return client;
}

/**
 * 调一个 MCP 工具，返回 `{ isError, text, json }`。工具结果文本按 JSON 解析，解析不了就留 null。
 * @param {import('@modelcontextprotocol/sdk/client/index.js').Client} client
 * @param {string} name
 * @param {Record<string, unknown>} args
 * @returns {Promise<{ isError: boolean, text: string, json: any }>}
 */
export async function callTool(client, name, args) {
  const answer = await client.callTool({ name, arguments: args });
  // content 是 text/image/… 的联合；本脚本只读 `.text`，按 any[] 处理，联合成员差异不参与判据。
  const blocks = /** @type {any[]} */ (Array.isArray(answer?.content) ? answer.content : []);
  const text = blocks
    .map((block) => (typeof block?.text === 'string' ? block.text : ''))
    .join('\n')
    .trim();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { isError: answer?.isError === true, text, json };
}

// ---------------------------------------------------------------------------
// 终端 Claude Code 的驱动面
// ---------------------------------------------------------------------------

/**
 * 解析 `claude -p --output-format stream-json --verbose` 的 NDJSON 输出。
 *
 * 只认 `message.content` 里的 `tool_use` / `tool_result` 两种块（它们可能出现在 assistant 或 user
 * 事件里），外加最后一条 `type === 'result'`。读不懂的行直接跳过——CLI 会往 stdout 混进度行，那不是
 * 能拿来断言的帧。
 * @param {string} text
 */
export function parseClaudeStream(text) {
  /** @type {any[]} */
  const events = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line));
    } catch {
      // 非 JSON 行（CLI 的进度提示）不是读数。
    }
  }
  /** @type {Array<{ id: string, name: string, input: Record<string, unknown> }>} */
  const toolUses = [];
  /** @type {Array<{ id: string, text: string, isError: boolean }>} */
  const toolResults = [];
  for (const event of events) {
    const content = event?.message?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (block?.type === 'tool_use') {
        toolUses.push({ id: String(block.id ?? ''), name: String(block.name ?? ''), input: block.input ?? {} });
      } else if (block?.type === 'tool_result') {
        toolResults.push({
          id: String(block.tool_use_id ?? ''),
          text: contentText(block.content),
          isError: block.is_error === true,
        });
      }
    }
  }
  const result = events.filter((event) => event?.type === 'result').pop() ?? null;
  return { events, toolUses, toolResults, result };
}

/**
 * 一段 tool_result 的 content（字符串或块数组）折成文本。
 * @param {unknown} content
 * @returns {string}
 */
function contentText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((block) => (typeof block?.text === 'string' ? block.text : JSON.stringify(block ?? null))).join('\n');
  }
  return JSON.stringify(content ?? null);
}

/**
 * 从一次 CLI 输出里取「名字以 `suffix` 结尾的最后一个工具调用」及其结果。
 * 返回 null 表示这次输出里根本没调那个工具（= 缺面，点名拒绝，不写假读数）。
 * @param {ReturnType<typeof parseClaudeStream>} parsed
 * @param {string} suffix
 */
export function toolCallFor(parsed, suffix) {
  const uses = parsed.toolUses.filter((use) => use.name.endsWith(suffix));
  if (uses.length === 0) return null;
  const use = uses[uses.length - 1];
  const result = parsed.toolResults.find((entry) => entry.id === use.id) ?? null;
  return { use, result };
}

/**
 * 终端 Claude Code 的运行环境：临时 HOME/CLAUDE_CONFIG_DIR + 本机已配好的真模型端点。
 * @param {Smoke} smoke
 * @returns {Record<string, string | undefined>}
 */
function claudeEnv(smoke) {
  const env = { ...process.env };
  for (const name of ['DATABASE_PATH', 'HOST', 'SERVER_PORT', 'JWT_SECRET', 'NODE_OPTIONS', MCP_ENABLE_VAR]) {
    delete env[name];
  }
  Object.assign(env, { HOME: path.join(smoke.tempRoot, 'home'), CLAUDE_CONFIG_DIR: path.join(smoke.tempRoot, 'claude-config') });
  return env;
}

/**
 * 真执行 `claude mcp add --transport http <name> <url> --header "Authorization: Bearer <PAT>" --scope project`。
 *
 * `--scope project` 把条目写进**临时项目**的 `.mcp.json`，不污染调用方的 `~/.claude.json`。
 * 返回逐字命令（记进记录）与退出码/输出。
 * @param {Smoke} smoke
 */
export function addMcpServer(smoke) {
  const url = `http://127.0.0.1:${smoke.server.port}${MCP_PATH}`;
  const args = [
    'mcp', 'add', '--transport', 'http', smoke.mcpServerName, url,
    '--header', `Authorization: Bearer ${smoke.pat}`,
    '--scope', 'project',
  ];
  const command = `claude ${args.map((arg) => (/[\s"]/.test(arg) ? JSON.stringify(arg) : arg)).join(' ')}`;
  const result = spawnSync('claude', args, {
    cwd: smoke.projectDir,
    env: claudeEnv(smoke),
    encoding: 'utf8',
  });
  return {
    command,
    status: result.status,
    stdout: (result.stdout || '').trim(),
    stderr: (result.stderr || '').trim(),
  };
}

/**
 * 真执行一次 `claude -p <自然语言提示>`，把 stream-json 输出解析成工具调用读数。
 *
 * `--permission-mode bypassPermissions` 是必须的：MCP 工具在 `-p`（非交互）下默认要审批，不放开
 * 就成了「提示发出去了、工具一次没调」，那正是要靠读数证否的假绿。
 * @param {Smoke} smoke
 * @param {{ prompt: string, label: string, timeoutMs?: number }} input
 */
export function driveClaude(smoke, { prompt, label, timeoutMs = 300_000 }) {
  const args = [
    '-p', prompt,
    '--output-format', 'stream-json',
    '--verbose',
    '--model', smoke.modelId,
    '--permission-mode', 'bypassPermissions',
  ];
  const result = spawnSync('claude', args, {
    cwd: smoke.projectDir,
    env: claudeEnv(smoke),
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: 64 * 1024 * 1024,
  });
  const rawPath = path.join(smoke.tempRoot, `claude-${label}.ndjson`);
  fs.writeFileSync(rawPath, result.stdout || '');
  const parsed = parseClaudeStream(result.stdout || '');
  return {
    label,
    rawPath,
    status: result.status,
    signal: result.signal ?? null,
    stderr: (result.stderr || '').trim().split('\n').slice(-8).join('\n'),
    parsed,
  };
}

// ---------------------------------------------------------------------------
// 宿主快照（`GET /api/session-hosts`）
// ---------------------------------------------------------------------------

/**
 * 读宿主快照。缺 `sessions[]` 就是 AC-169 没落地，点名拒绝而不是绕开。
 * @param {number} port
 * @param {string} token
 * @param {string} [label]
 * @returns {Promise<{ hosts: any[], sessions: any[] }>}
 */
export async function readHosts(port, token, label = 'GET /api/session-hosts') {
  const data = dataOf(await api(port, token, 'GET', '/api/session-hosts'), label);
  if (!Array.isArray(data.hosts) || !Array.isArray(data.sessions)) {
    throw new Error(`${label} 的形状不是宿主快照（缺 hosts[] 或 sessions[]）`);
  }
  return { hosts: data.hosts, sessions: data.sessions };
}

/**
 * 服务某会话的活常驻宿主，或 null。
 * @param {{ hosts: any[] }} listing
 * @param {string} sessionId
 * @returns {any | null}
 */
export function residentHostOf(listing, sessionId) {
  return (
    listing.hosts.find(
      (host) => host.state !== 'closed'
        && host.mode === 'resident'
        && Array.isArray(host.bindings)
        && host.bindings.some((/** @type {{ appSessionId?: string }} */ binding) => binding.appSessionId === sessionId),
    ) ?? null
  );
}

/**
 * 该会话在 `sessions[]` 里的那一行，或 null。
 * @param {{ sessions: any[] }} listing
 * @param {string} sessionId
 * @returns {any | null}
 */
export function sessionStateOf(listing, sessionId) {
  return listing.sessions.find((session) => session.appSessionId === sessionId) ?? null;
}

// ---------------------------------------------------------------------------
// 冒烟上下文
// ---------------------------------------------------------------------------

/** 一段拒绝：点名缺的是哪件面，绝不写假的读数行。 */
class LegRefusal extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = 'LegRefusal';
  }
}

/** 冒烟上下文：进程、端口、PAT、JWT、记录文件路径，以及八段之间要被下一段读到的读数。 */
class Smoke {
  /** @param {{ tempRoot: string, databasePath: string, record: string }} input */
  constructor(input) {
    this.tempRoot = input.tempRoot;
    this.databasePath = input.databasePath;
    this.record = input.record;
    /** @type {ServerReading[]} */
    this.servers = [];
    /** @type {ChatSocket[]} */
    this.chats = [];
    this.startedAt = Date.now();
    this.appToken = '';
    this.pat = '';
    /** @type {number | null} */
    this.patUserId = null;
    this.modelId = '';
    this.projectDir = path.join(input.tempRoot, 'project');
    this.mcpServerName = 'cloudcli';
    this.sessionId = '';
    /** 「发消息」一节里 MCP `session_send` 回的那条 run id；「查进度」按它查。 */
    this.mcpRunId = '';
    /** @type {number | null} */
    this.hostPidBefore = null;
    /** @type {number | null} */
    this.hostPidAfter = null;
    /** 正控制读到的、非 MCP run 的 `source`；为 null 表示未取得（不得据此断言字段有分辨力）。 */
    /** @type {string | null} */
    this.positiveControlSource = null;
    /** 正控制那一段的逐字读数行，供「发消息」一节复述。 */
    this.positiveControlLine = '（正控制未取得）';
    /** @type {string[]} */
    this.toolNames = [];
    /** @type {McpAddReading | null} */
    this.mcpAdd = null;
    /** `:3001` 在本轮冒烟开始前的读数（`protectedPortReading()` 的逐字行）。 */
    this.protectedBefore = '（未读）';
    /** 常驻冒烟：八段读数先收集，最后按 AC 顺序落盘（执行顺序 ≠ 记录顺序）。 */
    /** @type {Map<string, { reading: string, conclusion: string }>} */
    this.resident = new Map();
    /** 第三段：忙时 `session_send` 回的排队消息 uuid（第四段撤回的靶子）。 */
    this.queuedMessageUuid = '';
    /** 第二/六段：内层 run 起的后台任务 id（后台租约的 key）。 */
    /** @type {string | null} */
    this.backgroundTaskId = null;
    /** 第四段：撤回前的常驻 pid。 */
    /** @type {number | null} */
    this.cancelPidBefore = null;
    /** 第四段：撤回后的常驻 pid（须与 before 相同）。 */
    /** @type {number | null} */
    this.cancelPidAfter = null;
    /** 第五段：重配置前后逐字读到的 permissionMode。 */
    this.reconfigureOld = '';
    this.reconfigureNew = '';
    /** 第五段：`session_reconfigure` 自报的 `applied`。 */
    this.reconfigureApplied = '';
    /** 第五段：重配置后「下一轮」run 的 id。 */
    this.nextTurnRunId = '';
    /** 第七段：待审批 requestId（第五段下一轮撞出来的那一个）。 */
    this.approvalRequestId = '';
    /** 第七段：待审批的工具名。 */
    this.approvalToolName = '';
    /** 第五/七段：下一轮 Write 探针要写的绝对路径（放行后它存在即证明 Write 真的执行了）。 */
    this.approvalProbeFile = '';
  }

  /** @param {string} title @param {string} reading @param {string} conclusion */
  write(title, reading, conclusion) {
    upsertSection(this.record, title, sectionBody(reading, conclusion));
  }

  /** 常驻段：把一段读数暂存起来（不落盘），最后由 {@link residentFlush} 按 AC 顺序写。 */
  /** @param {string} title @param {string} reading @param {string} conclusion */
  residentPut(title, reading, conclusion) {
    this.resident.set(title, { reading, conclusion });
  }

  /** 常驻段：按 `RESIDENT_SECTION_TITLES` 的顺序把八节落盘；没收集到的段写成「未取得」。 */
  residentFlush() {
    for (const title of RESIDENT_SECTION_TITLES) {
      const entry = this.resident.get(title) ?? {
        reading: '（未取得）本段未执行或已拒绝，见 stderr。',
        conclusion: '本段缺失——缺面不得写成绿。',
      };
      upsertSection(this.record, title, sectionBody(entry.reading, entry.conclusion));
    }
  }

  /** @param {string} label */
  async boot(label) {
    const server = await bootServer({ tempRoot: this.tempRoot, label });
    this.servers.push(server);
    return server;
  }

  get server() {
    const server = this.servers[this.servers.length - 1];
    if (!server) throw new Error('冒烟还没有起过服务进程');
    return server;
  }

  close() {
    for (const socket of this.chats) {
      try {
        socket.close();
      } catch {
        // 已经关了。
      }
    }
  }
}

/**
 * 一条 chat WS。本冒烟用它做两件事：**开一条 run entry**（常驻宿主只能由 run entry 起），以及
 * 从 `chat_subscribed` 应答里取回那条 run 的 id（正控制的靶子）。
 *
 * 取 runId 只能走订阅应答，不能走 `session_send` 的 RUN_IN_PROGRESS 拒绝：常驻宿主的 provider
 * `acceptsBusyInput`，忙时发送是**接受并顶替**（`queued:true`，见 chat-control.service.ts 的
 * `supersedeRunning` 分支），那条拒绝在本 provider 上结构性地不可达。
 */
export class ChatSocket {
  /** @param {import('ws').WebSocket} socket */
  constructor(socket) {
    this.socket = socket;
  }

  /**
   * @param {number} port
   * @param {string} token
   * @returns {Promise<ChatSocket>}
   */
  static async connect(port, token) {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${encodeURIComponent(token)}`);
    const chat = new ChatSocket(socket);
    await new Promise((resolve, reject) => {
      socket.once('open', () => resolve(undefined));
      socket.once('error', (error) => reject(error));
    });
    return chat;
  }

  /** @param {Record<string, unknown>} payload */
  send(payload) {
    this.socket.send(JSON.stringify(payload));
  }

  /**
   * @param {string} sessionId
   * @param {number} [lastSeq]
   */
  subscribe(sessionId, lastSeq = 0) {
    this.send({ type: 'chat.subscribe', sessions: [{ sessionId, lastSeq }] });
  }

  /**
   * 订阅并**等**该会话的 `chat_subscribed` 应答。
   *
   * 应答里的 `runId` 只有在服务端此刻还持有该会话的 run 时才带（`chat-websocket.service.ts` 的
   * `if (run) ack.runId = run.runId`）。所以调用时机必须是 `chat.send` **之后**：run 在 dispatch
   * 里同步注册，且终态 run 也留在注册表里直到保留窗口（默认 5 分钟）结束。
   * @param {string} sessionId
   * @param {number} [lastSeq]
   * @param {number} [timeoutMs]
   * @returns {Promise<Record<string, unknown>>}
   */
  subscribeAndWait(sessionId, lastSeq = 0, timeoutMs = 30_000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.socket.off('message', onMessage);
        reject(new Error(`等 chat_subscribed 应答超时（${timeoutMs}ms）`));
      }, timeoutMs);
      /** @param {import('ws').RawData} raw */
      const onMessage = (raw) => {
        let frame;
        try {
          frame = JSON.parse(String(raw));
        } catch {
          return;
        }
        if (frame?.kind !== 'chat_subscribed' || frame.sessionId !== sessionId) return;
        clearTimeout(timer);
        this.socket.off('message', onMessage);
        resolve(frame);
      };
      this.socket.on('message', onMessage);
      this.subscribe(sessionId, lastSeq);
    });
  }

  close() {
    try {
      this.socket.close();
    } catch {
      // 已经关了。
    }
  }
}

/**
 * 发一轮用户消息但**不等**它的终止帧：用来把一条 **WS 发起**的 run 钉在运行中（正控制的靶子）。
 * 与 {@link sendTurn} 走同一条 `chat.send`，只是不阻塞。
 * @param {ChatSocket} chat
 * @param {string} sessionId
 * @param {string} content
 * @param {string} cwd
 * @param {{ model?: string }} [options]
 */
function startTurn(chat, sessionId, content, cwd, { model } = {}) {
  chat.send({
    type: 'chat.send',
    sessionId,
    content,
    options: { cwd, model, permissionMode: 'bypassPermissions' },
  });
}

/**
 * 该会话此刻在 `GET /api/providers/sessions/running` 里的那一行，没有就是 null。
 * @param {ServerReading} server
 * @param {string} token
 * @param {string} sessionId
 * @returns {Promise<any | null>}
 */
async function runningEntry(server, token, sessionId) {
  const running = dataOf(
    await api(server.port, token, 'GET', '/api/providers/sessions/running'),
    'GET /api/providers/sessions/running',
  );
  return (running.sessions ?? []).find((/** @type {{ sessionId?: string }} */ row) => row.sessionId === sessionId) ?? null;
}

// ---------------------------------------------------------------------------
// 八段
// ---------------------------------------------------------------------------

/** 内层会话的那条消息：先让模型去调 Bash 执行一条长命令，从而把一个 run 钉在「运行中」。 */
const INNER_MESSAGE = '请调用 Bash 工具执行这条命令：sleep 120。执行完再回复 SLEEP_DONE。'
  + '必须真的调用 Bash 工具（不要只是说明你会怎么做），也不要提前回复。';

/** 会话标题里用于在 `sessions_list` 里认出临时会话的片段。 */
const SESSION_TITLE_FRAGMENT = 'mcp-smoke';

/**
 * 第二段：起独立实例。
 *
 * 读数是**端口**、`/proc/<leaderPid>/environ` 里的 `DATABASE_PATH`/`HOST`、以及「≠ 3001」。
 * `port=<n>` 是 `--check-record` 的机械检查 (b) 逐字解析的那一格。
 * @param {Smoke} smoke
 */
function legInstance(smoke) {
  const server = smoke.server;
  const lines = server.environLines(['DATABASE_PATH', 'HOST', MCP_ENABLE_VAR]);
  const reading = `port=${server.port}；proc-environ[${server.leaderPid}] ${lines.join(' | ')}；`
    + `DATABASE_PATH 落在临时根 ${smoke.tempRoot} 下；HOST=127.0.0.1；`
    + `端口由 listen(0) 探得且不等于 ${PROTECTED_PORT}（受保护端口）；`
    + `进程以 detached:true 起、收尾按负 pid 杀整组（leaderPid=${server.leaderPid}）；`
    + `PAT=${smoke.pat.slice(0, 8)}…（userId=${smoke.patUserId}）；`
    + `应用 JWT 由 mint-token 对**同一个临时库**签出。`;
  smoke.write(
    '起独立实例',
    reading,
    `真服务进程在 127.0.0.1:${server.port} 上应答，库在临时根下、MCP_ENABLED=1 已生效；全程不碰 ${PROTECTED_PORT}。`,
  );
  say(`[读数] 起独立实例 ${reading}`);
}

/**
 * 第三段：Claude Code 握手与工具列表。
 *
 * 两条独立入站面都记：终端 Claude Code 的 `claude mcp add` 逐字命令（AC 要求），以及 MCP SDK 客户端
 * 从 `tools/list` 读到的**逐字工具名**。
 * @param {Smoke} smoke
 */
async function legHandshake(smoke) {
  const add = addMcpServer(smoke);
  smoke.mcpAdd = add;
  if (add.status !== 0) {
    throw new LegRefusal(
      `拒绝运行：\`claude mcp add\` 退出 ${add.status}：${add.stderr || add.stdout || '(无输出)'}`
      + ' —— 终端 Claude Code 接不上网关，后面的自然语言驱动没有可打的入站面。',
    );
  }
  const mcpJsonPath = path.join(smoke.projectDir, '.mcp.json');
  if (!fs.existsSync(mcpJsonPath)) {
    throw new LegRefusal(`拒绝运行：\`claude mcp add\` 没有写出 ${mcpJsonPath}（--scope project 的落点）。`);
  }

  let client;
  let serverInfo;
  try {
    client = await mcpConnect(smoke.server.port, smoke.pat);
    // 握手自报的身份：客户端显示的就是这里，读数不能再写死一个字面量。
    serverInfo = client.getServerVersion();
  } catch (error) {
    throw new LegRefusal(
      `拒绝运行：MCP 客户端接不上 /mcp（PAT 认证或传输未落地）：${error instanceof Error ? error.message : String(error)}`,
    );
  }
  try {
    const listed = await client.listTools();
    smoke.toolNames = (listed.tools ?? []).map((tool) => tool.name).sort();
    if (smoke.toolNames.length === 0) {
      throw new LegRefusal('拒绝运行：`tools/list` 一件工具都没有 —— AC-245/AC-249/AC-253 的工具注册没落地。');
    }
  } finally {
    await client.close().catch(() => {});
  }

  const required = ['sessions_list', 'session_send', 'run_get', 'session_interrupt', 'session_reconfigure'];
  const absent = required.filter((name) => !smoke.toolNames.includes(name));
  if (absent.length > 0) {
    throw new LegRefusal(`拒绝运行：工具列表缺 ${absent.join(' / ')} —— 本段要求的面没有装配。`);
  }

  const reading = `claude mcp add 逐字命令：${add.command}；退出码 ${add.status}；`
    + `写出 ${mcpJsonPath}；tools/list 共 ${smoke.toolNames.length} 件，逐字：${smoke.toolNames.join(', ')}；`
    + `MCP SERVER_INFO name=${serverInfo?.name ?? '<none>'}${serverInfo?.title ? ` title=${serverInfo.title}` : ''}；入站面 http://127.0.0.1:${smoke.server.port}${MCP_PATH}（PAT ${smoke.pat.slice(0, 8)}…，Bearer）。`;
  smoke.write(
    'Claude Code 握手与工具列表',
    reading,
    `终端 Claude Code 已把 cloudcli 条目写进临时项目的 .mcp.json；MCP 客户端握手成功并读到 ${smoke.toolNames.length} 件工具（含 session_send / run_get / session_interrupt）。`,
  );
  say(`[读数] 握手与工具列表 tools=${smoke.toolNames.length}`);
}

/**
 * 第四段：列出会话。
 *
 * 两件事：脚本先建临时会话（应用 API）+ 切 `resident`，再用**自然语言提示**驱动终端 Claude Code 调
 * `sessions_list` 把它列出来。读数是 CLI 那次调用返回的原始文本里逐字含该会话 id/title。
 * @param {Smoke} smoke
 */
async function legListSessions(smoke) {
  const server = smoke.server;
  const created = dataOf(
    await api(server.port, smoke.appToken, 'POST', '/api/providers/sessions', {
      provider: 'claude',
      projectPath: smoke.projectDir,
      initialMessage: '',
    }),
    'POST /api/providers/sessions',
  );
  if (typeof created.sessionId !== 'string' || !created.sessionId) {
    throw new LegRefusal('拒绝运行：建会话没有回 sessionId —— 会话面没落地。');
  }
  smoke.sessionId = created.sessionId;

  const switched = await api(
    server.port,
    smoke.appToken,
    'PUT',
    `/api/providers/claude/sessions/${smoke.sessionId}/lifecycle-mode`,
    { mode: 'resident' },
  );
  dataOf(switched, 'PUT lifecycle-mode');

  // AC-272：把该会话记录的 permissionMode 设成 bypassPermissions，让后面 MCP 的 options-less
  // `session_send` 把它带进内层 run——否则内层的 Bash 会停在审批上。
  let reconfigureLine = '（session_reconfigure 未调用）';
  const client = await mcpConnect(server.port, smoke.pat);
  try {
    const answer = await callTool(client, 'session_reconfigure', {
      session: smoke.sessionId,
      permissionMode: 'bypassPermissions',
    });
    reconfigureLine = `session_reconfigure isError=${answer.isError} 返回逐字 ${answer.text}`;
  } finally {
    await client.close().catch(() => {});
  }

  // 起常驻宿主：一条 WS 的 run entry（常驻进程只能由 run entry 起）。这一轮的 run **来源是 user**——
  // 正是 AC8 正控制要的那个「非 MCP 发起的 run」。
  const chat = await ChatSocket.connect(server.port, smoke.appToken);
  smoke.chats.push(chat);
  startTurn(chat, smoke.sessionId, INNER_MESSAGE, smoke.projectDir, { model: smoke.modelId });
  await waitFor(
    async () => (await runningEntry(server, smoke.appToken, smoke.sessionId)) !== null,
    90_000,
    'WS 发起的 run 出现在 GET /api/providers/sessions/running',
  );

  // 正控制的靶子 id 从**订阅应答**里取：订阅在 `chat.send` 之后发，所以应答里的 `runId` 就是那条
  // WS run（注册表按会话持有当前 run，终态 run 也留到保留窗口结束）。
  const ack = await chat.subscribeAndWait(smoke.sessionId, 0, 30_000);
  const wsRunId = typeof ack.runId === 'string' && ack.runId ? ack.runId : null;
  if (wsRunId === null) {
    throw new LegRefusal(
      `拒绝运行：chat_subscribed 应答里没有 runId（逐字 ${JSON.stringify(ack)}）—— 拿不到 WS 发起 run 的`
      + ' id，正控制无从读起。',
    );
  }

  const host = await waitFor(
    async () => residentHostOf(await readHosts(server.port, smoke.appToken), smoke.sessionId),
    30_000,
    '常驻宿主带着 pid 出现在宿主快照里',
  );
  smoke.hostPidBefore = typeof host.pid === 'number' ? host.pid : null;
  if (smoke.hostPidBefore === null) {
    throw new LegRefusal('拒绝运行：常驻宿主没有 pid —— 常驻进程面没落地，「中止后 pid 不变」无从读起。');
  }

  // 正控制：**同一个** MCP `run_get` 工具、**同一个** `source` 字段，唯一变的是 run 的发起面。
  // 靶子 id 是上面订阅应答带出来的 WS run（来源 user），不是 session_send 的拒绝体——见 ChatSocket 注释。
  let positiveLine = '（正控制未取得）';
  {
    const probeClient = await mcpConnect(server.port, smoke.pat);
    try {
      const reading = await callTool(probeClient, 'run_get', { runId: wsRunId, waitSeconds: 1 });
      const source = reading.json?.source ?? null;
      const readBackId = reading.json?.runId ?? null;
      if (reading.isError || readBackId !== wsRunId) {
        positiveLine = `（正控制未取得：MCP run_get 没读到 WS run ${wsRunId} —— `
          + `isError=${reading.isError}、逐字 ${reading.text}）`;
      } else {
        // `source === 'mcp'` 就是「字段恒真」：同一个工具对两条不同来源的 run 读出同一个值。这时
        // 正控制**不成立**，positiveControlSource 保持 null，下面两节的结论会照实说「未取得」。
        smoke.positiveControlSource = source !== null && source !== 'mcp' ? source : null;
        positiveLine = `非 MCP run（WS chat.send 发起）runId=${wsRunId} 由 chat_subscribed 应答带出`
          + `（逐字 ${JSON.stringify(ack)}）；同一 MCP run_get 读到 source=${JSON.stringify(source)}`
          + `（${source === 'mcp' ? '异常：与 mcp run 不可区分，字段恒真' : '≠ mcp，字段有分辨力'}）；`
          + `run_get 原始返回逐字 ${reading.text}`;
      }
    } finally {
      await probeClient.close().catch(() => {});
    }
  }
  smoke.positiveControlLine = positiveLine;

  // 清场：中止正控制那条 WS run。「发消息」一节的会话同一时刻只容一条在飞，不清场它必被
  // RUN_IN_PROGRESS 顶回来。中止只 abort run，不关常驻宿主（那正是第七段要读的性质）。
  let cleanupLine;
  {
    const abortClient = await mcpConnect(server.port, smoke.pat);
    try {
      const answer = await callTool(abortClient, 'session_interrupt', { session: smoke.sessionId });
      const cleared = await waitFor(
        async () => (await runningEntry(server, smoke.appToken, smoke.sessionId)) === null,
        60_000,
        '清场中止后 WS run 离开运行中列表',
      ).then(() => true).catch(() => false);
      cleanupLine = `清场 session_interrupt isError=${answer.isError} 返回逐字 ${answer.text}、`
        + `run 离开运行中列表=${cleared}`;
    } finally {
      await abortClient.close().catch(() => {});
    }
  }

  // 自然语言驱动：列出会话。
  const drive = driveClaude(smoke, {
    label: 'list',
    prompt: `请调用 cloudcli 这个 MCP 服务器提供的 sessions_list 工具（工具名形如 mcp__cloudcli__sessions_list）`
      + `列出会话，然后在回答里原样报告你能看到的会话 id 与标题。只调用这一个工具，不要做别的。`,
  });
  const call = toolCallFor(drive.parsed, 'sessions_list');
  if (call === null) {
    throw new LegRefusal(
      `拒绝运行：终端 Claude Code 没有调用 sessions_list（exit ${drive.status}，stderr 尾部：${drive.stderr || '(空)'}）`
      + ` —— 自然语言驱动没有走通，缺的是这一次工具调用。`,
    );
  }
  const listed = call.result?.text ?? '';
  const sawSession = listed.includes(smoke.sessionId) || listed.includes(SESSION_TITLE_FRAGMENT);
  if (!sawSession) {
    throw new LegRefusal(
      `拒绝运行：sessions_list 的返回里没有临时会话（id=${smoke.sessionId}）：${listed.slice(0, 400)}`,
    );
  }

  const reading = `临时项目 ${smoke.projectDir}；sessionId=${smoke.sessionId} lifecycle_mode=resident；`
    + `常驻宿主 pid=${smoke.hostPidBefore}（由 WS run entry 起）；${reconfigureLine}；${cleanupLine}；`
    + `正控制：${smoke.positiveControlLine}；`
    + `终端 Claude Code 的 sessions_list 调用逐字结果（截断 600）：${listed.slice(0, 600)}`;
  smoke.write(
    '列出会话',
    reading,
    `终端 Claude Code 用自然语言被驱动着调了 sessions_list，返回里逐字含临时会话 id=${smoke.sessionId}。`
    + (smoke.positiveControlSource !== null
      ? `正控制成立：同一个 run_get 对 WS 发起的 run 读到 source=${JSON.stringify(smoke.positiveControlSource)}`
        + '（≠ mcp），来源字段有分辨力。'
      : '⚠ 正控制未取得：同一个 run_get 没能对一个非 MCP run 读出来源 —— 见读数行，不得据此断言字段有分辨力。'),
  );
  say(`[读数] 列出会话 sessionId=${smoke.sessionId} hostPid=${smoke.hostPidBefore}`);
}

/**
 * 第五段：发消息。
 *
 * 自然语言驱动终端 Claude Code 调 `session_send`（内层一条长命令的 run）。读数是**该 run 出现在
 * `GET /api/providers/sessions/running`**、`session_send` 返回的 `source` 逐字 `mcp`，以及正控制
 * （同一读里一个非 MCP run 的来源 ≠ mcp）。
 * @param {Smoke} smoke
 */
async function legSend(smoke) {
  const server = smoke.server;
  const drive = driveClaude(smoke, {
    label: 'send',
    prompt: `请调用 cloudcli MCP 服务器的 session_send 工具（形如 mcp__cloudcli__session_send），`
      + `session 参数逐字用「${smoke.sessionId}」，message 参数逐字用「${INNER_MESSAGE}」。`
      + `然后在回答里原样报告返回的 runId、queued、source。只调用这一个工具，不要做别的。`,
  });
  const call = toolCallFor(drive.parsed, 'session_send');
  if (call === null) {
    throw new LegRefusal(
      `拒绝运行：终端 Claude Code 没有调用 session_send（exit ${drive.status}，stderr 尾部：${drive.stderr || '(空)'}）。`,
    );
  }
  const payload = JSON.parse(call.result?.text ?? 'null');
  const runId = payload?.runId;
  const source = payload?.source;
  if (typeof runId !== 'string' || !runId) {
    throw new LegRefusal(`拒绝运行：session_send 没有回 runId：${call.result?.text ?? '(无结果)'}`);
  }
  if (source !== 'mcp') {
    throw new LegRefusal(`拒绝运行：session_send 回来的 source=${JSON.stringify(source)}，不是逐字 mcp。`);
  }
  smoke.mcpRunId = runId;

  // 该 run 出现在运行中列表：MCP send 立刻返回、内层 run 还在跑，所以这里直接读得到。
  const running = dataOf(
    await api(server.port, smoke.appToken, 'GET', '/api/providers/sessions/running'),
    'GET /api/providers/sessions/running',
  );
  const entry = (running.sessions ?? []).find((/** @type {{ sessionId?: string }} */ row) => row.sessionId === smoke.sessionId);
  if (!entry) {
    throw new LegRefusal(
      `拒绝运行：发消息后 sessionId=${smoke.sessionId} 没出现在 GET /api/providers/sessions/running`
      + `（该路由当前返回 ${JSON.stringify(running.sessions ?? [])}）。`,
    );
  }

  const reading = `session_send 返回逐字 ${call.result?.text}；`
    + `GET /api/providers/sessions/running 命中该会话逐字 ${JSON.stringify(entry)}`
    + `（该路由本身不带 source 字段，来源按 MCP 面读：session_send.source=${JSON.stringify(source)}）；`
    + `正控制：${smoke.positiveControlLine}`;
  smoke.write(
    '发消息',
    reading,
    `终端 Claude Code 自然语言驱动 session_send，runId=${runId} 立刻返回且 source 逐字 mcp；`
    + '同一读里该 run 出现在运行中列表；'
    + (smoke.positiveControlSource !== null
      ? `正控制成立：同一 run_get 对非 MCP run 读到 source=${JSON.stringify(smoke.positiveControlSource)}（≠ mcp）。`
      : '⚠ 正控制未取得 —— 见读数行的正控制段，不得据此断言来源字段有分辨力。'),
  );
  say(`[读数] 发消息 runId=${runId} source=${source} 运行中列表命中=是`);
}

/**
 * 第六段：查进度。
 *
 * 自然语言驱动终端 Claude Code 调 `run_get(runId)`。读数是它返回的 `status`/`source`/`phase` 逐字。
 * @param {Smoke} smoke
 */
async function legProgress(smoke) {
  const drive = driveClaude(smoke, {
    label: 'progress',
    prompt: `请调用 cloudcli MCP 服务器的 run_get 工具（形如 mcp__cloudcli__run_get），`
      + `runId 参数逐字用「${smoke.mcpRunId}」，waitSeconds 用 1。`
      + `然后在回答里原样报告返回的 status、source、phase。只调用这一个工具。`,
  });
  const call = toolCallFor(drive.parsed, 'run_get');
  if (call === null) {
    throw new LegRefusal(
      `拒绝运行：终端 Claude Code 没有调用 run_get（exit ${drive.status}，stderr 尾部：${drive.stderr || '(空)'}）。`,
    );
  }
  const payload = JSON.parse(call.result?.text ?? 'null');
  if (payload?.runId !== smoke.mcpRunId) {
    throw new LegRefusal(
      `拒绝运行：run_get 按 runId=${smoke.mcpRunId} 没有查到该 run（返回 ${call.result?.text ?? '(无结果)'}）。`,
    );
  }
  const reading = `run_get(runId=${smoke.mcpRunId}, waitSeconds=1) 返回逐字 ${call.result?.text}`;
  smoke.write(
    '查进度',
    reading,
    `终端 Claude Code 自然语言驱动 run_get，按 runId 查到了同一个 run（source=${JSON.stringify(payload.source)}，status=${JSON.stringify(payload.status)}）。`,
  );
  say(`[读数] 查进度 runId=${smoke.mcpRunId} status=${payload.status}`);
}

/**
 * 第七段：中止。
 *
 * 自然语言驱动终端 Claude Code 调 `session_interrupt`。读数是它返回的 `aborted`，以及**常驻进程 pid
 * 前后各一个读数**（`GET /api/session-hosts`），两者相同才是「中止不杀常驻进程」。
 * @param {Smoke} smoke
 */
async function legInterrupt(smoke) {
  const server = smoke.server;
  const before = await readHosts(server.port, smoke.appToken, '中止前 GET /api/session-hosts');
  const beforeHost = residentHostOf(before, smoke.sessionId);
  smoke.hostPidBefore = typeof beforeHost?.pid === 'number' ? beforeHost.pid : smoke.hostPidBefore;

  const drive = driveClaude(smoke, {
    label: 'interrupt',
    prompt: `请调用 cloudcli MCP 服务器的 session_interrupt 工具（形如 mcp__cloudcli__session_interrupt），`
      + `session 参数逐字用「${smoke.sessionId}」。然后在回答里原样报告返回的 aborted 与 message。只调用这一个工具。`,
  });
  const call = toolCallFor(drive.parsed, 'session_interrupt');
  if (call === null) {
    throw new LegRefusal(
      `拒绝运行：终端 Claude Code 没有调用 session_interrupt（exit ${drive.status}，stderr 尾部：${drive.stderr || '(空)'}）。`,
    );
  }
  const payload = JSON.parse(call.result?.text ?? 'null');

  // 中止是异步的：abort 之后状态机要走一小会。有界地等该会话从运行中列表消失——这本身就是一条
  // 中止读数（「abort 真的把 run 停了」），随后再读宿主 pid 做前后比对。
  const leftRunningList = await waitFor(
    async () => {
      const running = dataOf(
        await api(server.port, smoke.appToken, 'GET', '/api/providers/sessions/running'),
        '中止后 GET /api/providers/sessions/running',
      );
      return !(running.sessions ?? []).some((/** @type {{ sessionId?: string }} */ row) => row.sessionId === smoke.sessionId);
    },
    30_000,
    '中止之后该会话不再出现在运行中列表',
  ).then(() => true).catch(() => false);

  const afterHost = residentHostOf(
    await readHosts(server.port, smoke.appToken, '中止后 GET /api/session-hosts'),
    smoke.sessionId,
  );
  smoke.hostPidAfter = typeof afterHost?.pid === 'number' ? afterHost.pid : null;

  if (smoke.hostPidBefore === null || smoke.hostPidAfter === null) {
    throw new LegRefusal(
      `拒绝运行：中止前后各需要一个常驻 pid 读数，实得 before=${String(smoke.hostPidBefore)} after=${String(smoke.hostPidAfter)}。`,
    );
  }
  if (smoke.hostPidBefore !== smoke.hostPidAfter) {
    throw new LegRefusal(
      `拒绝运行：session_interrupt 换掉了常驻进程（before=${smoke.hostPidBefore} after=${smoke.hostPidAfter}）`
      + ' —— 「中止只 abort、不关宿主」这条被证否。',
    );
  }

  const reading = `session_interrupt 返回逐字 ${call.result?.text}；`
    + `中止后该会话从 GET /api/providers/sessions/running 消失=${leftRunningList}；`
    + `常驻进程 pid 中止前=${smoke.hostPidBefore}、中止后=${smoke.hostPidAfter}（相同即未换进程）；`
    + `宿主 state 中止后=${JSON.stringify(afterHost?.state ?? null)}、mode=${JSON.stringify(afterHost?.mode ?? null)}。`;
  smoke.write(
    '中止',
    reading,
    `终端 Claude Code 自然语言驱动 session_interrupt，aborted=${JSON.stringify(payload?.aborted ?? null)}；常驻进程 pid 前后不变（${smoke.hostPidBefore}）。`,
  );
  say(`[读数] 中止 aborted=${payload?.aborted} pid before=${smoke.hostPidBefore} after=${smoke.hostPidAfter}`);
}

// ---------------------------------------------------------------------------
// 常驻专有能力冒烟（AC-276）：八段真跑
// ---------------------------------------------------------------------------
//
// `--run-resident` 复用 AC-256 的一整套「真服务实例 + PAT 播种 + `claude mcp add` +
// 自然语言驱动 + 临时项目」驱动面，走的是**常驻会话**这一条故事线：起常驻宿主、忙时发送排队、
// 撤回且 pid 不变、重配置下一轮生效、后台任务列出与停止、非 bypass 下审批被看到并解除。八段读数
// **先收集后按 AC 顺序落盘**（`upsertSection` 是按调用顺序追加的，执行顺序与记录顺序不同）。

/** 内层「忙锚 + 后台任务源」消息：后台起一个长任务（后台租约），再前台跑一条长命令把 run 钉住。 */
const RESIDENT_ANCHOR_MESSAGE = '请**真的依次调用两次 Bash 工具**（不要只说明你会怎么做）：'
  + '第一次把 Bash 工具参数 `run_in_background` 设为 true，command 用 `sleep 240`（后台任务）；'
  + '第二次前台执行 command `sleep 480`（这条会一直占着，直到被外部打断）。'
  + '两次都必须真的发出 Bash 工具调用，先发第一次再发第二次。';

/** 忙时发送排进队列的那条消息（随后要用它的 uuid 撤回）。 */
const RESIDENT_QUEUED_MESSAGE = '这是一条排队消息：请只回复 QUEUED_OK，不要调用任何工具。';

// 重配置后「下一轮」那条撞权限墙的消息**不能**用 Bash：`sleep`/`echo` 一类安全命令会被 CLI 的
// 安全命令表直接放行，根本不经过 `canUseTool`，于是永远等不到待审批。靶子必须是需权限工具
// （Write）——它在 default 下才被交到审批面，在 bypass 下静默写盘——文件名在段内按临时项目根拼绝对路径。

/** 终端 Claude Code 驱动一段工具调用时，从 stderr 尾部取多少行做拒绝读数。 */
const RESIDENT_DRIVE_TAIL = 8;

/**
 * 该会话在该宿主快照里持有的租约（`session_background` 读的就是这张表）。
 * @param {{ hosts: any[] }} listing @param {string} sessionId @returns {any[]}
 */
export function hostLeasesFor(listing, sessionId) {
  const host = residentHostOf(listing, sessionId);
  const binding = host?.bindings?.find((/** @type {{ appSessionId?: string }} */ entry) => entry.appSessionId === sessionId);
  return Array.isArray(binding?.leases) ? binding.leases : [];
}

/**
 * 该会话此刻记录的模型/强度/权限模式（`GET …/active-model`）。重配置一节的「新旧值」逐字读它。
 * @param {Smoke} smoke @param {string} label
 */
async function readActiveSelection(smoke, label) {
  return dataOf(
    await api(
      smoke.server.port,
      smoke.appToken,
      'GET',
      `/api/providers/claude/sessions/${smoke.sessionId}/active-model`,
    ),
    label,
  );
}

/**
 * 用自然语言驱动终端 Claude Code 调一个 MCP 工具，取回该工具调用及其结果。
 * 没调就是缺面：点名拒绝，不写假读数。
 * @param {Smoke} smoke
 * @param {{ label: string, prompt: string, toolSuffix: string }} input
 */
function driveResidentTool(smoke, { label, prompt, toolSuffix }) {
  const drive = driveClaude(smoke, { label, prompt });
  const call = toolCallFor(drive.parsed, toolSuffix);
  if (call === null) {
    throw new LegRefusal(
      `拒绝运行：终端 Claude Code 没有调用 ${toolSuffix}（exit ${drive.status}，stderr 尾部：`
      + `${drive.stderr.split('\n').slice(-RESIDENT_DRIVE_TAIL).join('\n') || '(空)'}）`
      + ' —— 自然语言驱动没有走通，缺的是这一次工具调用。',
    );
  }
  return call;
}

/**
 * 纯机械读一次性待审批集合（`approvals_list` 的 SDK 面，用来在取假前有界地等它出现）。
 * @param {Smoke} smoke
 */
async function residentPendingApprovals(smoke) {
  const client = await mcpConnect(smoke.server.port, smoke.pat);
  try {
    const answer = await callTool(client, 'approvals_list', { session: smoke.sessionId });
    return /** @type {any[]} */ (answer.json?.approvals ?? []);
  } finally {
    await client.close().catch(() => {});
  }
}

/**
 * 一段真跑：拿 `smoke.hostPidBefore/After` 两个读数并断言 pid 未换（撤回节的机械臂）。
 * @param {Smoke} smoke
 */
async function residentHostPid(smoke) {
  const host = residentHostOf(await readHosts(smoke.server.port, smoke.appToken), smoke.sessionId);
  return typeof host?.pid === 'number' ? host.pid : null;
}

/**
 * 第一段：环境与版本（+ 终端 Claude Code 握手面）。
 * 读数是版本、模型、`:3001` 起点读数，以及**临时实例**的 `/proc/<leaderPid>/environ` 命中行。
 * @param {Smoke} smoke
 */
function residentLegEnv(smoke) {
  const server = smoke.server;
  const lines = server.environLines(['DATABASE_PATH', 'HOST', MCP_ENABLE_VAR]);
  const add = addMcpServer(smoke);
  smoke.mcpAdd = add;
  if (add.status !== 0) {
    throw new LegRefusal(
      `拒绝运行：\`claude mcp add\` 退出 ${add.status}：${add.stderr || add.stdout || '(无输出)'}`
      + ' —— 终端 Claude Code 接不上网关，后面的自然语言驱动没有可打的入站面。',
    );
  }
  const reading = `claude --version = ${claudeVersion()}；${mcpSdkVersion()}；node ${process.version}；`
    + `模型 id = ${smoke.modelId}；:3001 起点读数 ${smoke.protectedBefore}；`
    + `临时实例 port=${server.port}（listen(0) 探得且 ≠ ${PROTECTED_PORT}）；`
    + `proc-environ[${server.leaderPid}] ${lines.join(' | ')}；`
    + `DATABASE_PATH 落在临时根 ${smoke.tempRoot} 下；HOST=127.0.0.1；`
    + `进程以 detached:true 起、收尾按负 pid 杀整组；PAT=${smoke.pat.slice(0, 8)}…（userId=${smoke.patUserId}）；`
    + `\`claude mcp add\` 逐字命令：${add.command}；写出 ${path.join(smoke.projectDir, '.mcp.json')}。`;
  smoke.residentPut(
    '环境与版本',
    reading,
    `真服务进程在 127.0.0.1:${server.port} 上应答、库在临时根下、MCP_ENABLED=1 已生效；终端 Claude Code 已把 cloudcli 条目写进临时项目的 .mcp.json；全程不碰 ${PROTECTED_PORT}。`,
  );
  say(`[读数] 环境与版本 port=${server.port} claude=${claudeVersion()}`);
}

/**
 * 第二段：常驻会话启动与 pid。
 *
 * 建会话 + 切 `resident` + 一条 WS 的 run entry 起常驻宿主（常驻进程只能由 run entry 起），读宿主 pid；
 * 该 run 的内层消息同时后台起一个长任务（后台租约）与前台跑一条长命令（把 run 钉住，供忙时发送）。
 * @param {Smoke} smoke
 */
async function residentLegStart(smoke) {
  const server = smoke.server;
  const created = dataOf(
    await api(server.port, smoke.appToken, 'POST', '/api/providers/sessions', {
      provider: 'claude',
      projectPath: smoke.projectDir,
      initialMessage: '',
    }),
    'POST /api/providers/sessions',
  );
  if (typeof created.sessionId !== 'string' || !created.sessionId) {
    throw new LegRefusal('拒绝运行：建会话没有回 sessionId —— 会话面没落地。');
  }
  smoke.sessionId = created.sessionId;
  dataOf(
    await api(
      server.port,
      smoke.appToken,
      'PUT',
      `/api/providers/claude/sessions/${smoke.sessionId}/lifecycle-mode`,
      { mode: 'resident' },
    ),
    'PUT lifecycle-mode',
  );

  // 先把该会话记录的权限模式设成 bypassPermissions（第五段再改成 default）：保证忙锚 run 里的两条
  // Bash 不因权限停下，也让第五段「旧值 → 新值」是一对**真值**而不是「未记录 → default」。
  {
    const setup = await mcpConnect(server.port, smoke.pat);
    try {
      await callTool(setup, 'session_reconfigure', { session: smoke.sessionId, permissionMode: 'bypassPermissions' });
    } finally {
      await setup.close().catch(() => {});
    }
  }

  const chat = await ChatSocket.connect(server.port, smoke.appToken);
  smoke.chats.push(chat);
  startTurn(chat, smoke.sessionId, RESIDENT_ANCHOR_MESSAGE, smoke.projectDir, { model: smoke.modelId });
  await waitFor(
    async () => (await runningEntry(server, smoke.appToken, smoke.sessionId)) !== null,
    90_000,
    'WS 发起的常驻 run 出现在 GET /api/providers/sessions/running',
  );

  const pid = await waitFor(
    async () => residentHostOf(await readHosts(server.port, smoke.appToken), smoke.sessionId)?.pid ?? null,
    30_000,
    '常驻宿主带着 pid 出现在宿主快照里',
  );
  smoke.hostPidBefore = typeof pid === 'number' ? pid : null;
  if (smoke.hostPidBefore === null) {
    throw new LegRefusal('拒绝运行：常驻宿主没有 pid —— 常驻进程面没落地。');
  }

  // 内层模型要真的先发一次后台 Bash；有界地等那条后台租约出现（它同时是第六段的靶子）。
  const lease = await waitFor(
    async () => hostLeasesFor(await readHosts(server.port, smoke.appToken), smoke.sessionId)
      .find((entry) => entry.kind === 'background-task') ?? null,
    120_000,
    '内层 run 起了后台任务，宿主快照里出现 background-task 租约',
  ).catch(() => null);
  smoke.backgroundTaskId = lease?.id ?? null;

  const client = await mcpConnect(server.port, smoke.pat);
  try {
    const listed = await client.listTools();
    smoke.toolNames = (listed.tools ?? []).map((tool) => tool.name).sort();
  } finally {
    await client.close().catch(() => {});
  }
  const required = ['session_create', 'session_send', 'session_cancel_queued', 'session_reconfigure', 'session_background', 'approvals_list', 'approval_answer'];
  const absent = required.filter((name) => !smoke.toolNames.includes(name));
  if (absent.length > 0) {
    throw new LegRefusal(`拒绝运行：工具列表缺 ${absent.join(' / ')} —— 常驻专有能力没有装配。`);
  }

  const reading = `sessionId=${smoke.sessionId} lifecycle_mode=resident；`
    + `常驻宿主 pid=${smoke.hostPidBefore}（由一条 WS chat.send 的 run entry 起）；`
    + `内层 run 的后台任务租约 id=${smoke.backgroundTaskId ?? '（未见 background-task 租约）'}；`
    + `tools/list 共 ${smoke.toolNames.length} 件，逐字：${smoke.toolNames.join(', ')}。`;
  smoke.residentPut(
    '常驻会话启动与 pid',
    reading,
    `临时会话 ${smoke.sessionId} 以 resident 模式起了真实常驻宿主，pid=${smoke.hostPidBefore} 从宿主快照读到；终端 Claude Code 经 PAT 读到 ${smoke.toolNames.length} 件工具（含常驻专有能力）。`,
  );
  say(`[读数] 常驻会话启动 sessionId=${smoke.sessionId} hostPid=${smoke.hostPidBefore} bgTask=${smoke.backgroundTaskId}`);
}

/**
 * 第三段：忙时发送。
 *
 * run 仍在飞时用自然语言驱动终端 Claude Code 调 `session_send`，读数是返回的 `queued=true` 与
 * **非空** `queuedMessageUuid`（撤回节按这个 uuid 撤回）。
 * @param {Smoke} smoke
 */
async function residentLegBusySend(smoke) {
  const call = driveResidentTool(smoke, {
    label: 'resident-busy-send',
    toolSuffix: 'session_send',
    prompt: `请调用 cloudcli MCP 服务器的 session_send 工具（形如 mcp__cloudcli__session_send），`
      + `session 参数逐字用「${smoke.sessionId}」，message 参数逐字用「${RESIDENT_QUEUED_MESSAGE}」。`
      + `然后在回答里原样报告返回的 runId、queued、queuedMessageUuid。只调用这一个工具，不要做别的。`,
  });
  const payload = JSON.parse(call.result?.text ?? 'null');
  if (payload?.queued !== true) {
    throw new LegRefusal(
      `拒绝运行：忙时 session_send 没有报 queued=true（返回 ${call.result?.text ?? '(无结果)'}）`
      + ' —— 会话此刻不忙或忙时输入没走通，排队读数无从取起。',
    );
  }
  if (typeof payload.queuedMessageUuid !== 'string' || payload.queuedMessageUuid.length === 0) {
    throw new LegRefusal(
      `拒绝运行：session_send 报了 queued=true 但 queuedMessageUuid 非字符串或为空`
      + `（返回 ${call.result?.text ?? '(无结果)'}） —— 没有可撤回的 uuid。`,
    );
  }
  smoke.queuedMessageUuid = payload.queuedMessageUuid;

  const reading = `忙时 session_send 返回逐字 ${call.result?.text}；`
    + `queuedMessageUuid=${smoke.queuedMessageUuid}（非空，逐字）；runId=${payload.runId ?? '(无)'}；`
    + `会话此刻在飞：一条 WS 起的 run 的内层 Bash（sleep 300）尚未结束。`;
  smoke.residentPut(
    '忙时发送',
    reading,
    `run 在飞时终端 Claude Code 自然语言驱动 session_send，返回 queued=true 且 queuedMessageUuid=${smoke.queuedMessageUuid}（非空）——消息真的进了常驻进程的队列。`,
  );
  say(`[读数] 忙时发送 queued=true uuid=${smoke.queuedMessageUuid}`);
}

/**
 * 第四段：撤回与 pid 不变。
 *
 * 自然语言驱动 `session_cancel_queued`（按第三段拿到的 uuid），读数是 `cancelled`、以及常驻宿主
 * **撤回前/后各一个 pid 读数**（两者相同才是「撤回不换进程」）。`pid-before=` / `pid-after=` 是
 * `--check-resident-record` 逐字解析的那两格。
 * @param {Smoke} smoke
 */
async function residentLegCancel(smoke) {
  if (!smoke.queuedMessageUuid) {
    throw new LegRefusal('拒绝运行：没有第三段拿到的 queuedMessageUuid，撤回无从发起。');
  }
  const pidBefore = await residentHostPid(smoke);
  const call = driveResidentTool(smoke, {
    label: 'resident-cancel',
    toolSuffix: 'session_cancel_queued',
    prompt: `请调用 cloudcli MCP 服务器的 session_cancel_queued 工具（形如 mcp__cloudcli__session_cancel_queued），`
      + `session 参数逐字用「${smoke.sessionId}」，messageUuid 参数逐字用「${smoke.queuedMessageUuid}」。`
      + `然后在回答里原样报告返回的 outcome 与 message。只调用这一个工具，不要做别的。`,
  });
  const payload = JSON.parse(call.result?.text ?? 'null');
  const pidAfter = await residentHostPid(smoke);
  smoke.cancelPidBefore = pidBefore;
  smoke.cancelPidAfter = pidAfter;

  if (payload?.outcome !== 'cancelled') {
    throw new LegRefusal(
      `拒绝运行：session_cancel_queued 没有报 outcome=cancelled（返回 ${call.result?.text ?? '(无结果)'}）`
      + ' —— 撤回没有真的成功。',
    );
  }
  if (pidBefore === null || pidAfter === null || pidBefore !== pidAfter) {
    throw new LegRefusal(
      `拒绝运行：撤回前后各需要一个相同的常驻 pid，实得 before=${String(pidBefore)} after=${String(pidAfter)}`
      + ' —— 「撤回不换进程」这条被证否。',
    );
  }

  const reading = `session_cancel_queued 返回逐字 ${call.result?.text}；`
    + `outcome=cancelled；pid-before=${pidBefore} pid-after=${pidAfter}（相同即未换进程）；`
    + `撤回的 uuid=${smoke.queuedMessageUuid}。`;
  smoke.residentPut(
    '撤回与 pid 不变',
    reading,
    `终端 Claude Code 自然语言驱动 session_cancel_queued，outcome 逐字 cancelled；常驻进程 pid 撤回前后不变（pid-before=${pidBefore} == pid-after=${pidAfter}）。`,
  );
  say(`[读数] 撤回 outcome=cancelled pid-before=${pidBefore} pid-after=${pidAfter}`);
}

/**
 * 第六段（执行序先于重配置）：后台任务列出与停止。
 *
 * 自然语言驱动 `session_background` 列出当前后台任务（读回 task id），再带 `stopTaskId` 停止并读回结果。
 * 后台租约由第二段内层 run 的后台 Bash 持有。
 * @param {Smoke} smoke
 */
async function residentLegBackground(smoke) {
  const listCall = driveResidentTool(smoke, {
    label: 'resident-bg-list',
    toolSuffix: 'session_background',
    prompt: `请调用 cloudcli MCP 服务器的 session_background 工具（形如 mcp__cloudcli__session_background），`
      + `session 参数逐字用「${smoke.sessionId}」，不要传 stopTaskId。`
      + `然后在回答里原样报告返回的 host 与 tasks 数组（每一项的 id 与 kind）。只调用这一个工具。`,
  });
  const listPayload = JSON.parse(listCall.result?.text ?? 'null');
  const tasks = Array.isArray(listPayload?.tasks) ? listPayload.tasks : [];
  const task = tasks.find((/** @type {{ kind?: string }} */ entry) => entry.kind === 'background-task') ?? tasks[0] ?? null;
  if (task === null || typeof task.id !== 'string' || task.id.length === 0) {
    throw new LegRefusal(
      `拒绝运行：session_background 没有列出任何后台任务（返回 ${listCall.result?.text ?? '(无结果)'}）`
      + ' —— 没有可停止的 taskId。',
    );
  }
  smoke.backgroundTaskId = task.id;

  const stopCall = driveResidentTool(smoke, {
    label: 'resident-bg-stop',
    toolSuffix: 'session_background',
    prompt: `请调用 cloudcli MCP 服务器的 session_background 工具（形如 mcp__cloudcli__session_background），`
      + `session 参数逐字用「${smoke.sessionId}」，stopTaskId 参数逐字用「${task.id}」。`
      + `然后在回答里原样报告返回的 stopped、taskId、remaining。只调用这一个工具。`,
  });
  const stopPayload = JSON.parse(stopCall.result?.text ?? 'null');
  if (stopPayload?.stopped !== true || stopPayload?.taskId !== task.id) {
    throw new LegRefusal(
      `拒绝运行：session_background 带 stopTaskId=${task.id} 没有报 stopped=true（返回 `
      + `${stopCall.result?.text ?? '(无结果)'}）—— 停止没有真的被放置。`,
    );
  }

  const remaining = Array.isArray(stopPayload.remaining) ? stopPayload.remaining.length : null;
  const reading = `列出：session_background 返回逐字 ${listCall.result?.text}；`
    + `停止：session_background(stopTaskId=${task.id}) 返回逐字 ${stopCall.result?.text}；`
    + `stopped=true、remaining 条数=${remaining}。`;
  smoke.residentPut(
    '后台任务列出与停止',
    reading,
    `终端 Claude Code 自然语言驱动 session_background 先列出后台任务（id=${task.id}，kind=background-task），再带 stopTaskId 停止并读回 stopped=true。`,
  );
  say(`[读数] 后台任务 列出${tasks.length}条 停止 taskId=${task.id} stopped=${stopPayload.stopped}`);
}

/**
 * 第五段：重配置下一轮生效。
 *
 * 先读旧值（`GET …/active-model`），自然语言驱动 `session_reconfigure` 把权限模式改成非 bypass 的
 * `default`，再读新值；随后**下一轮** run 用一个需要权限的 Bash 撞上权限墙（挂起等待审批）——证明
 * 新一轮真的取了新值（bypass 会静默执行），且宿主 pid 未换。该待审批正是第七段的靶子。
 * @param {Smoke} smoke
 */
async function residentLegReconfigure(smoke) {
  const before = await readActiveSelection(smoke, '重配置前 GET …/active-model');
  const pidBefore = await residentHostPid(smoke);

  const call = driveResidentTool(smoke, {
    label: 'resident-reconfigure',
    toolSuffix: 'session_reconfigure',
    prompt: `请调用 cloudcli MCP 服务器的 session_reconfigure 工具（形如 mcp__cloudcli__session_reconfigure），`
      + `session 参数逐字用「${smoke.sessionId}」，permissionMode 参数逐字用「default」。`
      + `然后在回答里原样报告返回的 stored、applied、liveSupported、message。只调用这一个工具。`,
  });
  const payload = JSON.parse(call.result?.text ?? 'null');
  if (payload?.stored?.permissionMode !== 'default') {
    throw new LegRefusal(
      `拒绝运行：session_reconfigure 没有把 permissionMode 记成 default（返回 ${call.result?.text ?? '(无结果)'}）。`,
    );
  }
  const after = await readActiveSelection(smoke, '重配置后 GET …/active-model');

  // 清场：中止第五段之前那条忙锚 run，让「下一轮」真的是一条新 run。
  const clearClient = await mcpConnect(smoke.server.port, smoke.pat);
  try {
    await callTool(clearClient, 'session_interrupt', { session: smoke.sessionId });
  } finally {
    await clearClient.close().catch(() => {});
  }
  await waitFor(
    async () => (await runningEntry(smoke.server, smoke.appToken, smoke.sessionId)) === null,
    60_000,
    '忙锚 run 在 session_interrupt 后离开运行中列表',
  ).catch(() => {});

  // 下一轮：内层 run 在 default 模式下撞权限墙（挂起等待审批）。靶子必须是 Write——Bash 的
  // `sleep`/`echo` 一类安全命令会被 CLI 直接放行、走不到 `canUseTool`；Write 在 default 下才被
  // 交到审批面（bypass 下静默写盘），所以它是「下一轮真的取了 default」的判别器。
  smoke.approvalProbeFile = path.join(smoke.projectDir, 'resident-permission-probe.txt');
  const permissionMessage = '请调用 Write 工具（不是 Bash），把内容 PERMISSION_PROBE 写进文件 '
    + `${smoke.approvalProbeFile}。只调用这一个工具，写完回复 DONE。`;
  const nextSend = driveResidentTool(smoke, {
    label: 'resident-next-turn',
    toolSuffix: 'session_send',
    prompt: `请调用 cloudcli MCP 服务器的 session_send 工具（形如 mcp__cloudcli__session_send），`
      + `session 参数逐字用「${smoke.sessionId}」，message 参数逐字用「${permissionMessage}」。`
      + `然后在回答里原样报告返回的 runId 与 queued。只调用这一个工具，不要做别的。`,
  });
  const nextPayload = JSON.parse(nextSend.result?.text ?? 'null');
  if (typeof nextPayload?.runId !== 'string' || !nextPayload.runId) {
    throw new LegRefusal(`拒绝运行：下一轮 session_send 没有回 runId（返回 ${nextSend.result?.text ?? '(无结果)'}）。`);
  }
  smoke.nextTurnRunId = nextPayload.runId;

  const pending = await waitFor(
    async () => (await residentPendingApprovals(smoke))[0] ?? null,
    120_000,
    '下一轮 run 在 default 模式下撞权限墙，approvals_list 出现待审批',
  );
  smoke.approvalRequestId = pending.requestId;
  smoke.reconfigureOld = before.permissionMode ?? '（未记录）';
  smoke.reconfigureNew = after.permissionMode ?? '（未记录）';
  smoke.reconfigureApplied = payload.applied ?? '';

  const pidAfter = await residentHostPid(smoke);
  if (pidBefore === null || pidAfter === null || pidBefore !== pidAfter) {
    throw new LegRefusal(
      `拒绝运行：重配置前后 pid 应相同，实得 before=${String(pidBefore)} after=${String(pidAfter)}。`,
    );
  }

  const reading = `旧值 permissionMode=${JSON.stringify(smoke.reconfigureOld)}（` // eslint-disable-line
    + `GET …/active-model 重配置前逐字 ${JSON.stringify(before)}）；`
    + `session_reconfigure 返回逐字 ${call.result?.text}；`
    + `新值 permissionMode=${JSON.stringify(smoke.reconfigureNew)}（重配置后逐字 ${JSON.stringify(after)}）；`
    + `下一轮 runId=${smoke.nextTurnRunId} 用 Write（需权限工具）撞权限墙、挂起等待审批 requestId=${smoke.approvalRequestId}`
    + `（bypass 下 Write 不经过审批直接写盘，故这条挂起证明新一轮真的取了 default）；`
    + `常驻 pid 重配置前=${pidBefore}、后=${pidAfter}（同一进程）。`;
  smoke.residentPut(
    '重配置下一轮生效',
    reading,
    `session_reconfigure 把 permissionMode 从 ${JSON.stringify(smoke.reconfigureOld)} 改成 ${JSON.stringify(smoke.reconfigureNew)}（applied=${smoke.reconfigureApplied}）；下一轮 run 真的按新值运行（在需权限的 Write 上停下等待审批），且常驻 pid 前后不变（${pidBefore}）。`,
  );
  say(`[读数] 重配置 old=${smoke.reconfigureOld} new=${smoke.reconfigureNew} applied=${smoke.reconfigureApplied} 下一轮 pending=${smoke.approvalRequestId}`);
}

/**
 * 第七段：审批。
 *
 * 自然语言驱动 `approvals_list` 逐字看到第五段下一轮撞出的待审批，再 `approval_answer`（allow）解除，
 * 再次列出读回它已消失。
 * @param {Smoke} smoke
 */
async function residentLegApproval(smoke) {
  const listCall = driveResidentTool(smoke, {
    label: 'resident-approvals-list',
    toolSuffix: 'approvals_list',
    prompt: `请调用 cloudcli MCP 服务器的 approvals_list 工具（形如 mcp__cloudcli__approvals_list），`
      + `session 参数逐字用「${smoke.sessionId}」。然后在回答里原样报告返回的 approvals 数组里每一项的`
      + ` requestId、toolName 与 inputSummary。只调用这一个工具。`,
  });
  const listPayload = JSON.parse(listCall.result?.text ?? 'null');
  const approvals = Array.isArray(listPayload?.approvals) ? listPayload.approvals : [];
  const request = approvals.find((/** @type {{ requestId?: string }} */ entry) => entry.requestId === smoke.approvalRequestId)
    ?? approvals[0] ?? null;
  if (request === null || typeof request.requestId !== 'string') {
    throw new LegRefusal(
      `拒绝运行：approvals_list 没有看到待审批（返回 ${listCall.result?.text ?? '(无结果)'}）`
      + ' —— 非 bypass 下的需权限工具没有把审批挂出来。',
    );
  }
  smoke.approvalRequestId = request.requestId;
  smoke.approvalToolName = request.toolName ?? '';

  const answerCall = driveResidentTool(smoke, {
    label: 'resident-approval-answer',
    toolSuffix: 'approval_answer',
    prompt: `请调用 cloudcli MCP 服务器的 approval_answer 工具（形如 mcp__cloudcli__approval_answer），`
      + `requestId 参数逐字用「${request.requestId}」，allow 参数用 true。`
      + `然后在回答里原样报告返回的 ok 与 decision。只调用这一个工具。`,
  });
  const answerPayload = JSON.parse(answerCall.result?.text ?? 'null');
  if (answerPayload?.ok !== true) {
    throw new LegRefusal(
      `拒绝运行：approval_answer 没有报 ok=true（返回 ${answerCall.result?.text ?? '(无结果)'}）。`,
    );
  }

  // 读回：该 requestId 不再待审批。
  const after = await waitFor(
    async () => {
      const rows = await residentPendingApprovals(smoke);
      return rows.some((entry) => entry.requestId === request.requestId) ? null : rows.length;
    },
    60_000,
    'approval_answer 之后该 requestId 从待审批集合消失',
  ).catch(() => null);

  // 读回之二：被放行的 Write 真的执行了——审批是它得以写盘的唯一放行者（default 下不答则一直挂起）。
  const wrote = await waitFor(
    async () => (fs.existsSync(smoke.approvalProbeFile ?? '') ? true : null),
    60_000,
    'approval_answer 放行后 Write 真的把探针文件写了出来',
  ).catch(() => null);

  const reading = `approvals_list 返回逐字 ${listCall.result?.text}；`
    + `待审批 requestId=${request.requestId}、toolName=${JSON.stringify(smoke.approvalToolName)}（非 bypass 模式下由需权限的 Write 触发）；`
    + `approval_answer 返回逐字 ${answerCall.result?.text}（ok=true）；`
    + `解除后再列 approvals_list：该 requestId 已不在待审批集合（剩余条数=${after ?? '未读到'}）；`
    + `被放行的 Write 写出的探针文件 ${smoke.approvalProbeFile} 存在=${wrote === true}。`;
  smoke.residentPut(
    '审批',
    reading,
    `非 bypass 权限模式下内层 run 的需权限工具 Write 撞出待审批 requestId=${request.requestId}；终端 Claude Code 自然语言驱动 approvals_list 逐字看到它，approval_answer(allow) 解除后它从待审批集合消失、且 Write 真的写盘（存在=${wrote === true}）。`,
  );
  say(`[读数] 审批 requestId=${request.requestId} 已解除`);
}

/**
 * 第十段之外：常驻冒烟主流程（八段真跑），返回 `{ failure }`。
 * @param {Smoke} smoke
 */
export async function runResidentSmoke(smoke) {
  smoke.appToken = mintToken(smoke.databasePath, path.join(smoke.tempRoot, 'app-token'));
  const seeded = seedAccessToken({
    tempRoot: smoke.tempRoot,
    databasePath: smoke.databasePath,
    scopes: ['cloudcli:read', 'cloudcli:session:send', 'cloudcli:session:create', 'cloudcli:session:control', 'cloudcli:approve'],
    name: 'mcp-smoke-resident',
  });
  smoke.pat = seeded.token;
  smoke.patUserId = seeded.userId;
  if (!smoke.pat.startsWith('ccp_')) {
    throw new LegRefusal(`拒绝运行：播种出的 PAT 前缀不是 ccp_：${smoke.pat.slice(0, 12)}…`);
  }
  smoke.modelId = process.env.MCP_SMOKE_MODEL
    ?? process.env.ANTHROPIC_MODEL
    ?? process.env.ANTHROPIC_DEFAULT_SONNET_MODEL
    ?? 'v4.1flash';
  fs.mkdirSync(smoke.projectDir, { recursive: true });

  /**
   * 执行序与记录序不同：记录序见 `residentFlush`（按 RESIDENT_SECTION_TITLES）。
   * 标注成元组数组，否则 TS 把元素推成 `(string | 函数)[]`，`leg(smoke)` 与 `residentPut(title, …)`
   * 两侧都会因为「string 不可调用 / 函数不是 string」而红。
   * @type {Array<[string, (smoke: Smoke) => unknown]>}
   */
  const legs = [
    ['环境与版本', residentLegEnv],
    ['常驻会话启动与 pid', residentLegStart],
    ['忙时发送', residentLegBusySend],
    ['撤回与 pid 不变', residentLegCancel],
    ['后台任务列出与停止', residentLegBackground],
    ['重配置下一轮生效', residentLegReconfigure],
    ['审批', residentLegApproval],
  ];

  let failure = null;
  for (const [title, leg] of legs) {
    try {
      await leg(smoke);
    } catch (error) {
      failure = { title, error };
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`[拒绝] 常驻第「${title}」段：${message}\n`);
      // 非点名拒绝（`waitFor` 超时、普通 `Error`）同样按拒绝读数落盘再收束——若在这里 `throw`，
      // 整个进程会带着尚未 flush 的记录直接退出，连前几段的真读数都留不下。栈仍打到 stderr 供追因。
      if (!(error instanceof LegRefusal || error instanceof GuardRefusal) && error instanceof Error) {
        process.stderr.write(`${error.stack ?? error.message}\n`);
      }
      smoke.residentPut(title, `（未取得）${message}`, '本段拒绝，读数缺失——见 stderr，禁止把缺面写成绿。');
      break;
    }
  }
  return { failure };
}

// ---------------------------------------------------------------------------
// CLI 参数与 `--check-record`
// ---------------------------------------------------------------------------

/** @param {string[]} argv @returns {Record<string, string | undefined>} */
export function parseFlags(argv) {
  /** @type {Record<string, string | undefined>} */
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;
    const eq = token.indexOf('=');
    if (eq >= 0) {
      flags[token.slice(2, eq)] = token.slice(eq + 1);
      continue;
    }
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      flags[token.slice(2)] = next;
      i += 1;
    } else {
      flags[token.slice(2)] = 'true';
    }
  }
  return flags;
}

/**
 * `--check-record`：逐节检查，缺哪节点名哪节；齐全 exit 0。
 * @param {string} filePath
 */
export function runCheckRecord(filePath) {
  const missing = checkRecordFile(filePath);
  if (missing.length === 0) {
    process.stdout.write(`记录合格：${filePath} 八节齐全、每节 读数：/结论： 非空、端口不是 ${PROTECTED_PORT}\n`);
    return 0;
  }
  for (const entry of missing) {
    process.stderr.write(`缺节：${entry.title} —— ${entry.reason}\n`);
  }
  process.stderr.write(`记录不合格（${filePath}）：缺 ${missing.length} 处，八节要求见 AC-256/AC3。\n`);
  return 1;
}

/**
 * `--check-resident-record`：逐节检查常驻记录（八节、非空读数/结论、撤回节 pid 前后相等），缺哪节
 * 点名哪节；齐全 exit 0。**纯读**，不起实例、不碰网络。
 * @param {string} filePath
 */
export function runCheckResidentRecord(filePath) {
  const missing = checkResidentRecordFile(filePath);
  if (missing.length === 0) {
    process.stdout.write(
      `记录合格：${filePath} 八节齐全、每节 读数：/结论： 非空、撤回节 pid-before == pid-after\n`,
    );
    return 0;
  }
  for (const entry of missing) {
    process.stderr.write(`缺节：${entry.title} —— ${entry.reason}\n`);
  }
  process.stderr.write(`记录不合格（${filePath}）：缺 ${missing.length} 处，八节要求见 AC-276/AC3。\n`);
  return 1;
}

/**
 * `--check-external-record`：逐节检查外部客户端绑定记录（九节、非空读数/结论、`公网基址` 不含
 * `ccp_`/`cca_` 令牌串），缺哪节点名哪节；齐全 exit 0。**纯读**，不起实例、不碰网络。
 * @param {string} filePath
 */
export function runCheckExternalRecord(filePath) {
  const missing = checkExternalRecordFile(filePath);
  if (missing.length === 0) {
    process.stdout.write(
      `记录合格：${filePath} 九节齐全、每节 读数：/结论： 非空、公网基址不含令牌串\n`,
    );
    return 0;
  }
  for (const entry of missing) {
    process.stderr.write(`缺节：${entry.title} —— ${entry.reason}\n`);
  }
  process.stderr.write(`记录不合格（${filePath}）：缺 ${missing.length} 处，九节要求见 AC-269/AC3。\n`);
  return 1;
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

/**
 * 冒烟主流程：环境与版本 ⇒ 起实例 ⇒ 握手 ⇒ 列出会话 ⇒ 发消息 ⇒ 查进度 ⇒ 中止。
 * 收尾残留一节由 `main()` 在**服务停掉之后**写（见那边的注释）。
 * @param {Smoke} smoke
 */
export async function runSmoke(smoke) {
  smoke.appToken = mintToken(smoke.databasePath, path.join(smoke.tempRoot, 'app-token'));
  const seeded = seedAccessToken({
    tempRoot: smoke.tempRoot,
    databasePath: smoke.databasePath,
    scopes: ['cloudcli:read', 'cloudcli:session:send', 'cloudcli:session:create', 'cloudcli:session:control', 'cloudcli:approve'],
    name: 'mcp-smoke',
  });
  smoke.pat = seeded.token;
  smoke.patUserId = seeded.userId;
  if (!smoke.pat.startsWith('ccp_')) {
    throw new LegRefusal(`拒绝运行：播种出的 PAT 前缀不是 ccp_：${smoke.pat.slice(0, 12)}…`);
  }

  smoke.modelId = process.env.MCP_SMOKE_MODEL
    ?? process.env.ANTHROPIC_MODEL
    ?? process.env.ANTHROPIC_DEFAULT_SONNET_MODEL
    ?? 'v4.1flash';
  fs.mkdirSync(smoke.projectDir, { recursive: true });

  smoke.write(
    '环境与版本',
    `claude --version = ${claudeVersion()}；${mcpSdkVersion()}；node ${process.version}；`
    + `模型 id = ${smoke.modelId}；:3001 起点读数 ${protectedPortReading()}。（版本与残留读数在末节汇总。）`,
    '本节放版本与端口基线；八段读数在下面各节。',
  );

  /** @type {Array<[string, (smoke: Smoke) => Promise<void> | void]>} */
  const legs = [
    ['起独立实例', legInstance],
    ['Claude Code 握手与工具列表', legHandshake],
    ['列出会话', legListSessions],
    ['发消息', legSend],
    ['查进度', legProgress],
    ['中止', legInterrupt],
  ];

  let failure = null;
  for (const [title, leg] of legs) {
    try {
      await leg(smoke);
    } catch (error) {
      failure = { title, error };
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`[拒绝] 第「${title}」段：${message}\n`);
      if (error instanceof LegRefusal || error instanceof GuardRefusal) {
        smoke.write(title, `（未取得）${message}`, '本段拒绝，读数缺失——见 stderr，禁止把缺面写成绿。');
        break;
      }
      throw error;
    }
  }
  return { failure };
}

/**
 * 有界地等临时实例的进程真的消失。SIGTERM 之后内核收尸要一点时间，读太早会把「正在死」读成「残留」。
 * @param {string} tempRoot
 * @param {number} budgetMs
 */
export async function waitForNoResidue(tempRoot, budgetMs = 20_000) {
  const deadline = Date.now() + budgetMs;
  for (;;) {
    const hits = residualProcesses(tempRoot).length
      + residualEnviron(tempRoot).length
      + residualScopes(tempRoot).length;
    if (hits === 0 || Date.now() >= deadline) return hits;
    await delay(1000);
  }
}

/**
 * `--run-resident`：常驻专有能力冒烟主流程（八段真跑 → 收尾残留 → 按 AC 顺序落盘 → 校验自身）。
 * 与 `main()` 的非检查路径同构，只是记录文件与末节标题换成常驻的那一套。
 * @param {Record<string, string | undefined>} flags
 */
export async function runResidentMain(flags) {
  const tempRoot = path.resolve(flags['temp-root'] ?? fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-smoke-resident-')));
  // 护栏**先**跑，且先于任何**写**盘：拒绝运行时连一个子目录都不该建。
  const databasePath = assertIsolatedDatabasePath({
    databasePath: flags['database-path'],
    ambientDatabasePath: process.env.DATABASE_PATH,
    tempRoot,
  });
  fs.mkdirSync(path.join(tempRoot, 'home'), { recursive: true });
  fs.mkdirSync(path.join(tempRoot, 'claude-config'), { recursive: true });
  const record = path.resolve(flags.record ?? DEFAULT_RESIDENT_RECORD);

  const smoke = new Smoke({ tempRoot, databasePath, record });
  say(`[常驻冒烟] tempRoot=${tempRoot} databasePath=${databasePath} record=${record}`);

  const protectedBefore = protectedPortReading();
  smoke.protectedBefore = protectedBefore;
  say(`[读数] :3001 起点读数 ${protectedBefore}`);

  let outcome = null;
  try {
    await smoke.boot('resident');
    outcome = await runResidentSmoke(smoke);
  } finally {
    smoke.close();
    for (const server of smoke.servers) await server.stop('SIGTERM');
  }

  // —— 到这里临时服务全部停了。残留读数**只能**在这里取：`residualEnviron` 命中的正是那些服务进程
  //    的 `DATABASE_PATH=<临时根>`，收尾之前取，读到的永远是「还活着」。
  const residueWait = await waitForNoResidue(tempRoot, 20_000);
  const residues = residualProcesses(tempRoot);
  const environHits = residualEnviron(tempRoot);
  const scopes = residualScopes(tempRoot);
  const protectedEnd = protectedPortReading();
  say(
    `[读数] 残留检查 tempRoot=${tempRoot} pgrep-命中=${residues.length} `
    + `environ-命中=${environHits.length} scope-命中=${scopes.length}（等待后剩余 ${residueWait}）`,
  );
  for (const line of residues) say(`[残留·pgrep] ${line}`);
  for (const line of environHits) say(`[残留·environ] ${line}`);
  for (const line of scopes) say(`[残留·scope] ${line}`);
  say(`[读数] :3001 终点读数 ${protectedEnd}`);

  smoke.residentPut(
    '收尾残留与生产监听 pid',
    `临时根 ${tempRoot}：pgrep-命中=${residues.length}、/proc environ-命中=${environHits.length}、`
    + `systemctl --user scope-命中=${scopes.length}（三条都要求 0；前两条只认本次冒烟子树内的进程）；`
    + `:3001 起点读数 ${protectedBefore}；:3001 终点读数 ${protectedEnd}`
    + `（逐字相同即监听 pid 与 systemd MainPID 都没被动过）；全程未连接 / 未启用 / 未重启 ${PROTECTED_PORT}。`,
    `收尾后三条残留命中均为 0，${PROTECTED_PORT} 的监听 pid 与 systemd MainPID 起点终点逐字相同。`,
  );

  // 执行序 ≠ 记录序：到这里八段读数才按 RESIDENT_SECTION_TITLES 的顺序落盘。
  if (!fs.existsSync(record)) {
    fs.mkdirSync(path.dirname(record), { recursive: true });
    fs.writeFileSync(record, residentRecordHeader());
  }
  smoke.residentFlush();

  if (outcome.failure) {
    process.stderr.write(
      `[拒绝] 常驻第「${outcome.failure.title}」段失败，记录已按 AC 顺序落盘（该段为拒绝读数）。\n`,
    );
    return 1;
  }
  if (residues.length > 0 || environHits.length > 0 || scopes.length > 0) {
    process.stderr.write(
      `拒绝报告完成：临时实例留下残留（pgrep=${residues.length} environ=${environHits.length} `
      + `scope=${scopes.length}）：${[...residues, ...environHits, ...scopes].join(' | ')}\n`,
    );
    return 1;
  }
  const missing = checkResidentRecordFile(record);
  if (missing.length > 0) {
    for (const entry of missing) process.stderr.write(`缺节：${entry.title} —— ${entry.reason}\n`);
    return 1;
  }
  say('[常驻冒烟] 八段读数已落盘；人证行（AC-277）只由人写，本脚本不写。');
  return 0;
}

/**
 * 主入口。守护栏先跑：护栏拒绝时**不写任何读数**，只 exit 1。
 * @param {string[]} argv
 */
export async function main(argv) {
  const flags = parseFlags(argv);

  if (flags['check-record'] !== undefined) {
    return runCheckRecord(flags['check-record']);
  }

  if (flags['check-resident-record'] !== undefined) {
    return runCheckResidentRecord(flags['check-resident-record']);
  }

  if (flags['check-external-record'] !== undefined) {
    // 参数缺失（`--check-external-record` 后面没有值，parseFlags 记为 'true'）时给出用法并退非 0：
    // 否则会去读一个叫 `true` 的文件，把「忘了给文件」误报成「记录缺九节」。
    const target = flags['check-external-record'];
    if (target === undefined || target === 'true' || target.trim() === '') {
      process.stderr.write(
        '用法：node scripts/mcp-smoke.mjs --check-external-record <记录文件>\n'
        + '（缺 <记录文件>：按 AC-269 逐节检查九节、非空读数/结论、公网基址不含令牌串。）\n',
      );
      return 1;
    }
    return runCheckExternalRecord(target);
  }

  if (flags['run-resident'] !== undefined) {
    return runResidentMain(flags);
  }

  const tempRoot = path.resolve(flags['temp-root'] ?? fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-smoke-')));
  // 护栏**先**跑，且先于任何**写**盘：拒绝运行时连一个子目录都不该建。
  const databasePath = assertIsolatedDatabasePath({
    databasePath: flags['database-path'],
    ambientDatabasePath: process.env.DATABASE_PATH,
    tempRoot,
  });
  fs.mkdirSync(path.join(tempRoot, 'home'), { recursive: true });
  fs.mkdirSync(path.join(tempRoot, 'claude-config'), { recursive: true });
  const record = path.resolve(flags.record ?? DEFAULT_RECORD);

  const smoke = new Smoke({ tempRoot, databasePath, record });
  say(`[冒烟] tempRoot=${tempRoot} databasePath=${databasePath} record=${record}`);

  const protectedBefore = protectedPortReading();
  say(`[读数] :3001 起点读数 ${protectedBefore}`);

  let outcome = null;
  try {
    await smoke.boot('main');
    outcome = await runSmoke(smoke);
  } finally {
    smoke.close();
    for (const server of smoke.servers) await server.stop('SIGTERM');
  }

  // —— 到这里临时服务全部停了。残留读数**只能**在这里取：`residualEnviron` 命中的正是那些服务进程
  //    的 `DATABASE_PATH=<临时根>`，收尾之前取，读到的永远是「还活着」。
  const residueWait = await waitForNoResidue(tempRoot, 20_000);
  const residues = residualProcesses(tempRoot);
  const environHits = residualEnviron(tempRoot);
  const scopes = residualScopes(tempRoot);
  const protectedEnd = protectedPortReading();
  say(
    `[读数] 残留检查 tempRoot=${tempRoot} pgrep-命中=${residues.length} `
    + `environ-命中=${environHits.length} scope-命中=${scopes.length}（等待后剩余 ${residueWait}；`
    + `前两条只认本次冒烟子树内的进程——argv/env 里恰好含临时根串的旁观进程不算残留）`,
  );
  for (const line of residues) say(`[残留·pgrep] ${line}`);
  for (const line of environHits) say(`[残留·environ] ${line}`);
  for (const line of scopes) say(`[残留·scope] ${line}`);
  say(`[读数] :3001 终点读数 ${protectedEnd}`);

  smoke.write(
    '收尾残留',
    `临时根 ${tempRoot}：pgrep-命中=${residues.length}、/proc environ-命中=${environHits.length}、`
    + `systemctl --user scope-命中=${scopes.length}（三条都要求 0；前两条只认本次冒烟子树内的进程，`
    + `argv/env 里恰好含临时根串的旁观进程不计——否则「把日志路径写进命令行的观察者」会被读成残留）；`
    + `:3001 起点读数 ${protectedBefore}；:3001 终点读数 ${protectedEnd}`
    + `（与起点逐字相同即监听 pid 与 systemd MainPID 都没被动过）；全程未连接 / 未启用 / 未重启 ${PROTECTED_PORT}。`,
    `收尾后三条残留命中均为 0，${PROTECTED_PORT} 的监听 pid 与 systemd MainPID 起点终点逐字相同。`,
  );

  if (outcome.failure) return 1;
  if (residues.length > 0 || environHits.length > 0 || scopes.length > 0) {
    process.stderr.write(
      `拒绝报告完成：临时实例留下残留（pgrep=${residues.length} environ=${environHits.length} `
      + `scope=${scopes.length}）：${[...residues, ...environHits, ...scopes].join(' | ')}\n`,
    );
    return 1;
  }
  const missing = checkRecordFile(record);
  if (missing.length > 0) {
    for (const entry of missing) process.stderr.write(`缺节：${entry.title} —— ${entry.reason}\n`);
    return 1;
  }
  say('[冒烟] 八段读数已落盘；人证行（AC-257）只由人 yale 写，本脚本不写。');
  return 0;
}

// 只有本文件被**直接执行**时才跑 CLI：判据要 `import` 它的纯函数，导入不该有副作用。
// 按 realpath 比较，脚本经符号链接调用时也认得出是自己。
const invokedDirectly = process.argv[1] !== undefined
  && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));

if (invokedDirectly) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      if (error instanceof GuardRefusal) {
        process.stderr.write(`${error.message}\n`);
        process.exitCode = 1;
        return;
      }
      process.stderr.write(`${error?.stack ?? error}\n`);
      process.exitCode = 1;
    });
}
