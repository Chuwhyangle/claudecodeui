import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, it } from 'vitest';

/**
 * The chat page's two standing banners are paused together.
 *
 * The workspace used to hand `NoticeSlot` down as ChatInterface's `noticeSlot` prop, and
 * ChatInterface rendered the session task chain above the transcript. Both are application- or
 * job-level information that spent real rows on a conversation page; the decision is to take the
 * mounts out until the chat page's signal design is settled, while keeping the components, the
 * server notices route and the cockpit deploy strip.
 *
 * This file reads the two source files as text because the claim is about a MOUNT that must not
 * appear — rendering the tree in jsdom would only prove the current test setup did not supply the
 * prop. Paths resolve from `process.cwd()`: under vitest's jsdom environment `import.meta.url` is
 * not a `file://` URL, and the repo's other source-reading criteria do the same.
 *
 * The paused-marker assertion is the positive control: it proves the read landed on the real,
 * non-empty source and that the two sites were annotated, so the absence below cannot pass
 * against a file that was moved, emptied or replaced by a stub.
 */

const PAUSED_MARKER = '待 Chat 页信号设计定稿';

const SOURCE_FILES = [
  'src/modules/project-workspace/WorkspaceMain.tsx',
  'src/modules/chat/ChatInterface.tsx',
] as const;

/** A JSX mount of one of the banner components, e.g. `<NoticeSlot />` or `<SessionTaskChain …`. */
const BANNER_MOUNT = /<(NoticeSlot|SessionTaskChain|DeployReadiness)\b/;

function readSource(relativePath: string): string {
  return readFileSync(resolve(process.cwd(), relativePath), 'utf8');
}

describe('chat banners are paused', () => {
  for (const relativePath of SOURCE_FILES) {
    it(`${relativePath} mounts no standing status banner`, () => {
      const source = readSource(relativePath);

      assert.ok(source.trim().length > 0, `${relativePath} read as empty`);
      assert.ok(
        source.includes(PAUSED_MARKER),
        `${relativePath} does not carry the paused marker (${PAUSED_MARKER})`,
      );

      const mount = source.match(BANNER_MOUNT);
      assert.equal(
        mount,
        null,
        `${relativePath} still mounts <${mount?.[1] ?? ''}>; the chat banners are paused`,
      );
    });
  }

  it('the workspace no longer hands a slot down to the chat page', () => {
    const source = readSource('src/modules/project-workspace/WorkspaceMain.tsx');

    assert.ok(
      !source.includes('noticeSlot'),
      'WorkspaceMain still passes noticeSlot to ChatInterface; the chat banners are paused',
    );
  });

  it('the chat page keeps the generic slot seam', () => {
    // The pause removes the MOUNT, not the seam: a later signal design (or another caller) can
    // still hand the chat page a node, and an absent one must render nothing rather than a bar.
    const source = readSource('src/modules/chat/ChatInterface.tsx');

    assert.ok(
      source.includes('noticeSlot?: React.ReactNode;'),
      'ChatInterface dropped the generic noticeSlot prop; the pause only removes the mount',
    );
    assert.ok(
      source.includes('{noticeSlot}'),
      'ChatInterface no longer renders its noticeSlot child',
    );
  });
});
