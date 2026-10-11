import s from "@/app/landing.module.css";

// Atlas's mark, the same glossy aqua globe as the launch video (video/src/components/Logo.tsx).
// The meridians turn in CSS: each one's width follows |sin λ|, staggered a quarter turn apart.
// `id` keeps the gradient ids unique when the globe appears more than once on a page.
export function AtlasOrb({ size, id, className }: { size: number; id: string; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 100 100" className={className} aria-hidden="true">
      <defs>
        <radialGradient id={`${id}-body`} cx="38%" cy="30%" r="75%">
          <stop offset="0%" stopColor="#bff0ff" />
          <stop offset="35%" stopColor="#5cc4f4" />
          <stop offset="75%" stopColor="#1584c4" />
          <stop offset="100%" stopColor="#0b5d8f" />
        </radialGradient>
        <linearGradient id={`${id}-gloss`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#fff" stopOpacity="0.95" />
          <stop offset="100%" stopColor="#fff" stopOpacity="0" />
        </linearGradient>
        <radialGradient id={`${id}-glow`} cx="50%" cy="85%" r="45%">
          <stop offset="0%" stopColor="#c8f7ff" stopOpacity="0.9" />
          <stop offset="100%" stopColor="#c8f7ff" stopOpacity="0" />
        </radialGradient>
        <clipPath id={`${id}-clip`}>
          <circle cx="50" cy="50" r="46" />
        </clipPath>
      </defs>
      <circle cx="50" cy="52" r="46" fill="#0b5d8f" opacity="0.18" />
      <circle cx="50" cy="50" r="46" fill={`url(#${id}-body)`} />
      <g clipPath={`url(#${id}-clip)`} stroke="#ffffff" strokeOpacity="0.55" strokeWidth="1.6" fill="none">
        {[0, 1, 2, 3].map((k) => (
          <ellipse
            key={k}
            cx="50"
            cy="50"
            rx="46"
            ry="46"
            className={s.meridian}
            vectorEffect="non-scaling-stroke"
            style={{ ["--k" as string]: k, transform: `scaleX(${Math.max(0.01, Math.abs(Math.sin((k * Math.PI) / 4)))})` }}
          />
        ))}
        <ellipse cx="50" cy="50" rx="46" ry="16" />
        <line x1="4" y1="50" x2="96" y2="50" />
        <ellipse cx="50" cy="30" rx="38" ry="9" opacity="0.6" />
        <ellipse cx="50" cy="70" rx="38" ry="9" opacity="0.6" />
      </g>
      <circle cx="50" cy="50" r="46" fill={`url(#${id}-glow)`} />
      <ellipse cx="50" cy="27" rx="33" ry="19" fill={`url(#${id}-gloss)`} />
      <circle cx="50" cy="50" r="45.2" fill="none" stroke="#ffffff" strokeOpacity="0.7" strokeWidth="1.4" />
    </svg>
  );
}
