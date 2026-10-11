"use client";

import { useEffect } from "react";

// Fades [data-reveal] blocks in as they scroll into view. Without JavaScript, or with reduced
// motion, nothing is hidden: the hiding CSS only applies once <html> has .reveal-ready.
export function Reveal() {
  useEffect(() => {
    if (!("IntersectionObserver" in window) || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const els = Array.from(document.querySelectorAll<HTMLElement>("[data-reveal]"));
    // Whatever is already on screen shows at once, so nothing flashes out and back in.
    for (const el of els) if (el.getBoundingClientRect().top < innerHeight) el.dataset.shown = "";
    document.documentElement.classList.add("reveal-ready");
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (!e.isIntersecting) continue;
          (e.target as HTMLElement).dataset.shown = "";
          io.unobserve(e.target);
        }
      },
      { rootMargin: "0px 0px -12% 0px" },
    );
    for (const el of els) if (!("shown" in el.dataset)) io.observe(el);
    return () => {
      io.disconnect();
      document.documentElement.classList.remove("reveal-ready");
    };
  }, []);
  return null;
}
