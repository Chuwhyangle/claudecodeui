/**
 * The MCP contract's one tool registry: the structure the gateway consumes so
 * it never imports a concrete domain tool package (proposal rule R3).
 *
 * A composition root builds it from the domain packages' `McpToolModule`
 * declarations; the gateway answers `tools/list` and dispatch from `get` /
 * `all`. The registry is deliberately inert — it holds declarations and never
 * runs a handler itself, so the audited wrapper remains the one call path.
 *
 * Consumers: the composition root (`server/index.ts`, stage 2) and the gateway.
 * Stage 1 ships the structure only; the gateway still registers its current
 * tools through the audited seam until the domain packages exist.
 */

import type { McpToolDefinition } from './tool-definition.js';
import type { McpToolModule, McpToolRegistry } from './types.js';

/**
 * The in-memory registry over one flat list of tool declarations.
 *
 * A duplicate `name` is a wiring bug, not a last-writer-wins merge: two packages
 * claiming one `tools/list` name would make dispatch arbitrary, so the
 * constructor throws and names the collision instead of silently dropping one.
 */
export class ToolRegistry implements McpToolRegistry {
  private readonly toolsByName: Map<string, McpToolDefinition>;

  constructor(tools: readonly McpToolDefinition[] = []) {
    this.toolsByName = new Map();
    for (const tool of tools) {
      if (this.toolsByName.has(tool.name)) {
        throw new Error(`Two MCP tool declarations share the name "${tool.name}".`);
      }
      this.toolsByName.set(tool.name, tool);
    }
  }

  /** The tool registered under `name`, or `undefined`. */
  get(name: string): McpToolDefinition | undefined {
    return this.toolsByName.get(name);
  }

  /** Every registered tool, in registration order. */
  all(): McpToolDefinition[] {
    return [...this.toolsByName.values()];
  }
}

/**
 * Builds a registry from domain modules, flattening each module's tools in
 * declaration order. A convenience for the composition root; equivalent to
 * `new ToolRegistry(modules.flatMap((module) => module.tools))`.
 */
export function createToolRegistry(modules: readonly McpToolModule[]): ToolRegistry {
  return new ToolRegistry(modules.flatMap((module) => module.tools));
}
