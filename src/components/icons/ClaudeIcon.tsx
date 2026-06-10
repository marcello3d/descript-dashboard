// Clawd — the pixel-art Claude Code mascot.
// Geometry from clawd-on-desk's clawd-static-base.svg (MIT,
// https://github.com/rullerzhou-afk/clawd-on-desk), minus the ground shadow.
export default function ClaudeIcon({ className = "w-3.5 h-3.5 flex-shrink-0" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 6 15 9" aria-hidden="true">
      <g fill="#D97757">
        <rect x="2" y="6" width="11" height="7" />
        {/* claws */}
        <rect x="0" y="9" width="2" height="2" />
        <rect x="13" y="9" width="2" height="2" />
        {/* legs */}
        <rect x="3" y="13" width="1" height="2" />
        <rect x="5" y="13" width="1" height="2" />
        <rect x="9" y="13" width="1" height="2" />
        <rect x="11" y="13" width="1" height="2" />
      </g>
      <g fill="#000000">
        <rect x="4" y="8" width="1" height="2" />
        <rect x="10" y="8" width="1" height="2" />
      </g>
    </svg>
  );
}
