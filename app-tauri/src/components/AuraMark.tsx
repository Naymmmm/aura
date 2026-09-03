// The Aura asterisk mark — port of the Flutter `_AsteriskPainter`.
export function AuraMark({
  size = 28,
  color = "currentColor",
  className,
}: {
  size?: number;
  color?: string;
  className?: string;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      className={className}
      aria-hidden="true"
    >
      <g
        stroke={color}
        strokeWidth={Math.max(1.8, size * 0.1)}
        strokeLinecap="square"
      >
        <line x1="3" y1="12" x2="21" y2="12" />
        <line x1="12" y1="3" x2="12" y2="21" />
        <line x1="4.5" y1="4.5" x2="19.5" y2="19.5" />
        <line x1="19.5" y1="4.5" x2="4.5" y2="19.5" />
      </g>
    </svg>
  );
}
