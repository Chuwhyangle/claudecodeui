import * as React from 'react';

import { cn } from '@/shared/utils';

type ShimmerProps = {
  children: string;
  className?: string;
  as?: React.ElementType;
};

/**
 * A working-state label: the text pulses instead of sweeping a gradient.
 *
 * The old sheen animated `background-position` on `bg-clip-text`, which asks the
 * browser to recalculate style and repaint the glyphs on every frame. This
 * component is on screen for as long as a turn runs — the activity dock's
 * `Thinking…` label, a streaming plan title, a reasoning placeholder — so that
 * per-frame work was a permanent cost, not a moment of streaming. Opacity is
 * the one property the compositor can animate without touching style or paint.
 *
 * Used by the chat module for streaming placeholder text and by the shared
 * Reasoning primitive.
 */
export const Shimmer = React.memo<ShimmerProps>(({ children, className, as: Component = 'span' }) => {
  return (
    <Component className={cn('inline-block motion-safe:animate-pulse', className)}>
      {children}
    </Component>
  );
});
Shimmer.displayName = 'Shimmer';

