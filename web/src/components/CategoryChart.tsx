/** "Donors by category" — horizontal bars, longest first (the Streamlit page's Altair chart). */
export default function CategoryChart({ counts }: { counts: [string, number][] }) {
  const max = Math.max(1, ...counts.map(([, n]) => n));
  return (
    <ul className="space-y-2.5" aria-label="Donors by category">
      {counts.map(([cat, n]) => (
        <li key={cat} className="grid grid-cols-[minmax(0,45%)_1fr_2.5rem] items-center gap-3 text-sm sm:grid-cols-[minmax(0,22rem)_1fr_2.5rem]">
          <span className="truncate text-ink-700" title={cat}>{cat}</span>
          <span className="h-2.5 overflow-hidden rounded-full bg-ink-100">
            <span
              className="block h-full rounded-full bg-accent-600 transition-[width] duration-500"
              style={{ width: `${(n / max) * 100}%` }}
            />
          </span>
          <span className="text-right font-semibold tabular-nums text-brand-700">{n}</span>
        </li>
      ))}
    </ul>
  );
}
