// Claude / Anthropic sunburst mark
const SPOKES = [0, 30, 60, 90, 120, 150, 180, 210, 240, 270, 300, 330];

export default function ClaudeIcon({ className = "w-3.5 h-3.5 flex-shrink-0" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden="true">
      <g stroke="#D97757" strokeWidth="2.4" strokeLinecap="round">
        {SPOKES.map((angle) => (
          <line key={angle} x1="12" y1="12" x2="12" y2="2.5" transform={`rotate(${angle} 12 12)`} />
        ))}
      </g>
    </svg>
  );
}
