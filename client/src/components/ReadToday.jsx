import React, { useEffect, useState } from "react";
import { api } from "../api.js";
import { Section } from "./ui.jsx";
import { SiteChip } from "./LinkRow.jsx";

/** "Para leer hoy": the day's picks from /api/resurface. Hidden when there is nothing to suggest. */
export default function ReadToday({ refreshKey }) {
  const [data, setData] = useState(null);
  useEffect(() => { api.resurface().then(setData).catch(() => setData(null)); }, [refreshKey]);
  if (!data || !data.items.length) return null;
  return (
    <Section title="Para leer hoy" aside={<span className="help text-[12px]">{data.items.length} {data.items.length === 1 ? "enlace" : "enlaces"} guardados hace tiempo</span>} className="mb-5">
      <ul className="divide-y" style={{ borderColor: "var(--line)" }} aria-label="Para leer hoy">
        {data.items.map((l) => (
          <li key={l.id} className="flex items-start gap-3 py-2.5">
            <SiteChip site={l.site} />
            <a href={`#/link/${l.id}`} className="min-w-0 flex-1">
              <span className="block truncate text-[14px] font-semibold">{l.title || l.url}</span>
              <span className="help block truncate text-[12px]">{l.site} · {l.reason}</span>
            </a>
          </li>
        ))}
      </ul>
    </Section>
  );
}
