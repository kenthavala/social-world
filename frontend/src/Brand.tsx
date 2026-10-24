// The Social World mark and wordmark. Geometry from the brand spec:
// a source-document square, six unconnected people, and a broken world ring.

export function Mark({ size = 20, label, className }: {
  size?: number;
  label?: string;
  className?: string;
}) {
  // Optical sizes: small marks need heavier dots and ring to stay legible.
  const dotR = size <= 20 ? 3.4 : size <= 24 ? 3.1 : size <= 32 ? 2.8 : 2.4;
  const ringW = size <= 20 ? 3.0 : size <= 24 ? 2.6 : size <= 32 ? 2.2 : 1.6;
  const dots = [
    [24, 12], [34.39, 18], [34.39, 30], [24, 36], [13.61, 30], [13.61, 18],
  ];
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 48 48"
      className={className}
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      focusable="false"
    >
      <circle
        cx="24" cy="24" r="21" fill="none"
        stroke="var(--brand-ring, #808994)" strokeWidth={ringW}
        strokeDasharray="32 12" strokeLinecap="round"
        transform="rotate(-80 24 24)"
      />
      {dots.map(([cx, cy]) => (
        <circle key={`${cx}-${cy}`} cx={cx} cy={cy} r={dotR}
                fill="var(--brand-ink, #E8EBEF)" />
      ))}
      <rect x="19.5" y="19.5" width="9" height="9" rx="1.6"
            fill="var(--source, #D6C6A1)" />
    </svg>
  );
}

export function Wordmark({ compact }: { compact?: boolean }) {
  return (
    <a className="wordmark" href="#/" aria-label="The Social World — home"
       style={compact ? { marginBottom: 0 } : undefined}>
      <Mark size={20} />
      <span className="wm-text"><span className="wm-the">The</span>{" "}
        <span className="wm-name">Social World</span></span>
    </a>
  );
}

export function LoadingMark({ size = 28, progress }: {
  size?: number;
  progress?: number | null;
}) {
  const filled = progress == null ? 0 : Math.max(0, Math.min(6, Math.floor(progress * 6)));
  const dotR = size <= 24 ? 3.1 : size <= 32 ? 2.8 : 2.4;
  const ringW = size <= 24 ? 2.6 : size <= 32 ? 2.2 : 1.6;
  const dots = [
    [24, 12], [34.39, 18], [34.39, 30], [24, 36], [13.61, 30], [13.61, 18],
  ];
  return (
    <svg width={size} height={size} viewBox="0 0 48 48" className="brand-loading"
         role="img" aria-label="Working">
      <circle
        cx="24" cy="24" r="21" fill="none"
        stroke="var(--brand-ring, #808994)" strokeWidth={ringW}
        strokeDasharray="132" strokeDashoffset="132" strokeLinecap="round"
        transform="rotate(-80 24 24)"
        style={{ animation: "brand-draw 600ms var(--ease) forwards" }}
      />
      {dots.map(([cx, cy], i) => (
        <circle key={`${cx}-${cy}`} cx={cx} cy={cy} r={dotR}
                fill="var(--brand-ink, #E8EBEF)"
                style={{
                  opacity: i < filled ? 1 : 0.16,
                  transition: "opacity 200ms var(--ease)",
                }} />
      ))}
      <rect x="19.5" y="19.5" width="9" height="9" rx="1.6"
            fill="var(--source, #D6C6A1)" />
    </svg>
  );
}
