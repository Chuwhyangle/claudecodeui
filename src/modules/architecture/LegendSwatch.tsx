/**
 * One legend glyph: a line style, an arrow head, a stereotype badge or the seed
 * frame.
 *
 * Used by `ArchitecturePanel` only.
 */
export function LegendSwatch({ glyph }: { readonly glyph: string }) {
  const stroke = 'currentColor';
  const common = { fill: 'none', stroke, strokeWidth: 1.2 } as const;
  return (
    <svg
      viewBox="0 0 34 14"
      width="34"
      height="14"
      aria-hidden="true"
      data-architecture-legend-swatch={glyph}
      className="shrink-0 text-muted-foreground"
    >
      {glyph === 'association' && <line x1="2" y1="7" x2="32" y2="7" {...common} />}
      {glyph === 'dependency' && <line x1="2" y1="7" x2="32" y2="7" strokeDasharray="4 2" {...common} />}
      {/* Solid line + hollow triangle, versus the dashed line below: the old
          legend printed `△` for both inheritance and implementation. */}
      {glyph === 'inheritance' && (
        <>
          <line x1="2" y1="7" x2="24" y2="7" {...common} />
          <path d="M24 2 L33 7 L24 12 Z" {...common} />
        </>
      )}
      {glyph === 'implementation' && (
        <>
          <line x1="2" y1="7" x2="24" y2="7" strokeDasharray="4 2" {...common} />
          <path d="M24 2 L33 7 L24 12 Z" {...common} />
        </>
      )}
      {glyph === 'composition' && (
        <>
          <line x1="8" y1="7" x2="32" y2="7" {...common} />
          <path d="M2 7 L5 4 L8 7 L5 10 Z" fill={stroke} stroke={stroke} strokeWidth="1.2" />
        </>
      )}
      {glyph === 'aggregation' && (
        <>
          <line x1="8" y1="7" x2="32" y2="7" {...common} />
          <path d="M2 7 L5 4 L8 7 L5 10 Z" {...common} />
        </>
      )}
      {glyph === 'stereotype' && (
        <>
          <rect x="1" y="3" width="32" height="8" rx="2" {...common} />
          <line x1="6" y1="7" x2="28" y2="7" strokeDasharray="2 2" {...common} />
        </>
      )}
      {/* A seed is the ORANGE THICK frame, not a `●` dot. */}
      {glyph === 'seed' && (
        <rect x="2" y="2" width="30" height="10" rx="1.5" fill="none" stroke="#d97706" strokeWidth="2.5" />
      )}
      {glyph === 'folded' && (
        <>
          <rect x="2" y="2" width="30" height="10" rx="2" strokeDasharray="3 2" {...common} />
          <line x1="12" y1="7" x2="22" y2="7" {...common} />
          <path d="M12 4 L9 7 L12 10" {...common} />
          <path d="M22 4 L25 7 L22 10" {...common} />
        </>
      )}
    </svg>
  );
}
