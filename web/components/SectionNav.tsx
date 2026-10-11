"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";

const SECTIONS = [
  { href: "", label: "Overview" },
  { href: "/itinerary", label: "Itinerary" },
];

export function SectionNav({ tripId }: { tripId: string }) {
  const path = usePathname();
  return (
    <nav className="sections glass">
      {SECTIONS.map((s) => {
        const href = `/t/${tripId}${s.href}`;
        return (
          <Link key={s.label} href={href} aria-current={path === href ? "page" : undefined}>
            {s.label}
          </Link>
        );
      })}
    </nav>
  );
}
