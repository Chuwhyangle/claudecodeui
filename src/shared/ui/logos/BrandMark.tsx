import { BRAND } from '@/shared/constants';

type BrandMarkSize = 'sm' | 'md';

const BRAND_MARK_SIZE_CLASSES: Record<BrandMarkSize, string> = {
  sm: 'h-14 w-14',
  md: 'h-16 w-16',
};

type BrandMarkProps = {
  /** `sm` is the OAuth consent page's 56px mark; `md` is the 64px auth-screen mark. */
  size?: BrandMarkSize;
};

/**
 * Used by the auth module's loading, login and setup screens and the oauth-consent
 * module's consent page. The logo artwork carries its own navy field, so the mark is
 * rendered as the tile itself: no accent-colored wrapper (which framed the navy square
 * in bright blue) and no size mismatch between the tile and the artwork.
 */
export function BrandMark({ size = 'md' }: BrandMarkProps) {
  return (
    <img
      src="/logo.svg"
      alt={BRAND.name}
      className={`${BRAND_MARK_SIZE_CLASSES[size]} block rounded-2xl shadow-[0_10px_24px_-10px_rgba(2,20,44,0.55)] ring-1 ring-black/5 dark:ring-white/10`}
    />
  );
}
