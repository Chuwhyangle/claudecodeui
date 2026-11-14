/**
 * The file-writing half of the architecture tab's export menu.
 *
 * The menu itself lives in `ArchitecturePanel.tsx`; this module owns only the
 * artifact mechanics that are independent of React and therefore testable on
 * their own: the filename scheme, the download triggers, the SVG clean-up the
 * live drawing needs before it is a standalone file, and the PNG rasterisation
 * with its 2× / 8192px bounds.
 *
 * Everything here is module-private to the architecture feature (the panel is
 * its only consumer), so it stays beside the panel rather than moving to
 * `src/shared`.
 */

/** The PNG rasterisation scale named by the export menu's PNG entry. */
export const EXPORT_PNG_SCALE = 2;

/**
 * The longest side a rasterised PNG may have. A diagram larger than this is
 * scaled down proportionally: canvas implementations reject (or silently
 * clamp) very large bitmaps, and a 2× rendering of a wide diagram can exceed
 * the browser's supported area long before the tab notices.
 */
export const EXPORT_PNG_MAX_EDGE = 8192;

/** Which subgraph the export describes; `entity` is the class diagram. */
export type ArchitectureExportGranularity = 'entity' | 'file';

/** One artifact size in CSS/SVG user units. */
export type ArchitectureExportSize = {
  readonly width: number;
  readonly height: number;
};

/** The bitmap the PNG entry will produce, plus whether it had to be capped. */
export type ArchitecturePngTarget = {
  readonly width: number;
  readonly height: number;
  /** True when the 2× bitmap exceeded {@link EXPORT_PNG_MAX_EDGE}. */
  readonly downscaled: boolean;
  /** The effective scale after the long-side cap. */
  readonly scale: number;
};

/** A filename segment that every supported OS accepts. */
export function sanitizeFilenameSegment(value: string): string {
  const cleaned = value
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[\\/:*?"<>|]+/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '');
  return cleaned === '' ? 'project' : cleaned;
}

/** `YYYYMMDD-HHmm` in the reader's local time, the stamp the filename carries. */
export function exportTimestamp(date: Date): string {
  const pad = (value: number): string => String(value).padStart(2, '0');
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
    '-',
    pad(date.getHours()),
    pad(date.getMinutes()),
  ].join('');
}

/**
 * The exported artifact's filename.
 *
 * `architecture-class-<project>-<YYYYMMDD-HHmm>.<ext>` for the class (entity)
 * diagram, `architecture-file-…` for the file graph. The project token is the
 * selected project's id, made filename-safe; an absent id falls back to
 * `project` rather than producing `architecture-class--…`.
 */
export function architectureExportFilename(
  granularity: ArchitectureExportGranularity,
  projectId: string | null,
  date: Date,
  extension: string,
): string {
  const kind = granularity === 'entity' ? 'class' : 'file';
  const project = sanitizeFilenameSegment(projectId ?? 'project');
  return `architecture-${kind}-${project}-${exportTimestamp(date)}.${extension}`;
}

/**
 * The bitmap size for one drawing: {@link EXPORT_PNG_SCALE}× the natural size,
 * with the longest side capped at {@link EXPORT_PNG_MAX_EDGE}. `downscaled`
 * lets the caller tell the reader when the cap changed the picture; the
 * returned dimensions never exceed the cap.
 */
export function pngTargetSize(
  natural: ArchitectureExportSize,
  scale: number = EXPORT_PNG_SCALE,
  maxEdge: number = EXPORT_PNG_MAX_EDGE,
): ArchitecturePngTarget {
  const safeWidth = Number.isFinite(natural.width) && natural.width > 0 ? natural.width : 1;
  const safeHeight = Number.isFinite(natural.height) && natural.height > 0 ? natural.height : 1;
  const idealWidth = safeWidth * scale;
  const idealHeight = safeHeight * scale;
  const longest = Math.max(idealWidth, idealHeight);
  if (longest <= maxEdge) {
    return {
      width: Math.max(1, Math.round(idealWidth)),
      height: Math.max(1, Math.round(idealHeight)),
      downscaled: false,
      scale,
    };
  }
  const factor = maxEdge / longest;
  return {
    width: Math.max(1, Math.min(maxEdge, Math.round(idealWidth * factor))),
    height: Math.max(1, Math.min(maxEdge, Math.round(idealHeight * factor))),
    downscaled: true,
    scale: scale * factor,
  };
}

/**
 * Serialise the live SVG as a standalone document.
 *
 * Two things are removed because they belong to the running page, not to the
 * file: the `arch-dim`/`arch-hl-*` highlight classes the hover/selection
 * helpers paint at runtime (they would export a dimmed picture nobody asked
 * for), and the inline `width`/`height` the viewport writes while fitting the
 * drawing into its container. The `viewBox` stays, so an SVG viewer scales the
 * document to whatever box it is opened in.
 */
export function serializeSvgForExport(svg: SVGSVGElement): string {
  const clone = svg.cloneNode(true) as SVGSVGElement;
  for (const element of clone.querySelectorAll('.arch-dim, .arch-hl-in, .arch-hl-out')) {
    element.classList.remove('arch-dim', 'arch-hl-in', 'arch-hl-out');
  }
  clone.removeAttribute('width');
  clone.removeAttribute('height');
  clone.removeAttribute('style');
  if (!clone.getAttribute('xmlns')) {
    clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  }
  return new XMLSerializer().serializeToString(clone);
}

/** Write a Blob through a temporary object URL and an anchor click. */
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

/** The text-file special case of {@link downloadBlob}. */
export function downloadTextFile(
  contents: string,
  filename: string,
  mimeType: string = 'text/plain;charset=utf-8',
): void {
  downloadBlob(new Blob([contents], { type: mimeType }), filename);
}

/**
 * Rasterise an SVG document at the given bitmap size.
 *
 * The browser loads the serialised SVG through an object URL, draws it into a
 * canvas of exactly `target` pixels and encodes a PNG. Rejections are returned
 * to the caller as errors (the menu reports them instead of breaking the tab);
 * a browser without a 2D canvas rejects with `canvas-2d-unavailable`.
 */
export function rasterizeSvgToPng(
  svgText: string,
  target: Pick<ArchitecturePngTarget, 'width' | 'height'>,
): Promise<Blob> {
  return new Promise<Blob>((resolve, reject) => {
    const svgBlob = new Blob([svgText], { type: 'image/svg+xml;charset=utf-8' });
    const url = URL.createObjectURL(svgBlob);
    const image = new Image();
    image.onload = () => {
      try {
        const canvas = document.createElement('canvas');
        canvas.width = target.width;
        canvas.height = target.height;
        const context = canvas.getContext('2d');
        if (context === null) throw new Error('canvas-2d-unavailable');
        context.drawImage(image, 0, 0, target.width, target.height);
        canvas.toBlob((blob) => {
          URL.revokeObjectURL(url);
          if (blob === null) {
            reject(new Error('png-encode-failed'));
            return;
          }
          resolve(blob);
        }, 'image/png');
      } catch (error) {
        URL.revokeObjectURL(url);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('svg-load-failed'));
    };
    image.src = url;
  });
}
