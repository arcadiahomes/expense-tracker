import Image from "next/image";
import mark from "@/assets/arcadia-mark.png";

/** Arcadia Homes & Lifestyle mark: the tree of overlapping circles. */
export function Logo({ className }: { className?: string }) {
  return <Image src={mark} alt="" aria-hidden className={`object-contain ${className ?? "size-9"}`} />;
}
