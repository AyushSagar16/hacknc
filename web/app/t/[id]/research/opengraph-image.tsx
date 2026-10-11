import { ogContentType, ogSize, sectionImage } from "@/lib/og";

export const size = ogSize;
export const contentType = ogContentType;
export const alt = "Trip research";

export default async function Image({ params }: { params: Promise<{ id: string }> }) {
  return sectionImage((await params).id, "research");
}
