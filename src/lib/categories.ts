import {
  Boxes,
  CircleEllipsis,
  HardHat,
  Truck,
  Wrench,
  type LucideIcon,
} from "lucide-react";
import type { Category } from "./types";

/**
 * Category order is fixed: it is the validated colour order for charts
 * (see --cat-* tokens in globals.css). Never re-sort before assigning colour.
 */
export const CATEGORY_META: Record<
  Category,
  { label: string; icon: LucideIcon; color: string; hint: string }
> = {
  materials: { label: "Materials", icon: Boxes, color: "var(--cat-materials)", hint: "Cement, steel, sand, bricks" },
  labour: { label: "Labour", icon: HardHat, color: "var(--cat-labour)", hint: "Wages, contracts, gangs" },
  transport: { label: "Transport", icon: Truck, color: "var(--cat-transport)", hint: "Lorry, tractor, pickup" },
  equipment: { label: "Equipment", icon: Wrench, color: "var(--cat-equipment)", hint: "JCB, mixer, diesel, rentals" },
  other: { label: "Other", icon: CircleEllipsis, color: "var(--cat-other)", hint: "Permits, tea, safety gear" },
};
