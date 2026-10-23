/** "Donors by category" — horizontal bars, longest first (the Streamlit page's Altair chart). */
export default function CategoryChart({ counts }: { counts: [string, number][] }) {
  const max = Math.max(1, ...counts.map(([, n]) => n));
  return (
    <ul className="space-y-2" aria-label="Donors by category">
      {counts.map(([cat, n]) => (
        <li key={cat} className="grid grid-cols-[minmax(0,45%)_1fr_2.5rem] sm:grid-cols-[minmax(0,22rem)_1fr_2.5rem] items-center gap-3 text-sm">
          <span className="truncate text-slate-700" title={cat}>{cat}</span>
          <span className="h-3 rounded-full bg-slate-100">
            <span className="block h-3 rounded-full bg-brand" style={{ width: `${(n / max) * 100}%` }} />
          </span>
          <span className="text-right font-semibold tabular-nums text-navy">{n}</span>
        </li>
      ))}
    </ul>
  );
}
