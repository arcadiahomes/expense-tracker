/**
 * Demo data for `npm run db:seed`, moved from the old client-side mock store.
 * Dates are written relative to SEED_REFERENCE_DATE; the seed shifts them so the
 * demo always ends "today".
 */

export const SEED_REFERENCE_DATE = "2026-10-20";

type Category = "materials" | "labour" | "transport" | "equipment" | "other";
type SeedSite = {
  id: string;
  name: string;
  location: string;
  client: string;
  engineer: string;
  budget: number;
  startDate: string;
  status: "active" | "on-hold" | "completed";
};
type SeedBill = {
  id: string;
  billNo: string;
  supplier: string;
  siteId: string;
  date: string;
  dueDate: string;
  amount: number;
  paid: number;
  status: string;
  description: string;
  attachment?: { name: string; size: number; kind: "pdf" | "image" };
};

export const SITES: SeedSite[] = [
  {
    id: "kakkanad-residency",
    name: "Kakkanad Residency",
    location: "Kakkanad, Kochi",
    client: "Menon Builders",
    engineer: "Arun Varghese",
    budget: 18_500_000,
    startDate: "2026-03-02",
    status: "active",
  },
  {
    id: "whitefield-villa",
    name: "Whitefield Villa 12",
    location: "Whitefield, Bengaluru",
    client: "Dr. Kavya Rao",
    engineer: "Suresh Gowda",
    budget: 6_200_000,
    startDate: "2026-05-18",
    status: "active",
  },
  {
    id: "anna-nagar-duplex",
    name: "Anna Nagar Duplex",
    location: "Anna Nagar, Chennai",
    client: "R. Senthil Kumar",
    engineer: "Priya Natarajan",
    budget: 4_800_000,
    startDate: "2026-04-07",
    status: "active",
  },
  {
    id: "thrissur-warehouse",
    name: "Thrissur Warehouse",
    location: "Ollur, Thrissur",
    client: "Chakola Traders",
    engineer: "Arun Varghese",
    budget: 9_400_000,
    startDate: "2026-06-23",
    status: "active",
  },
  {
    id: "kowdiar-clinic",
    name: "Kowdiar Dental Clinic",
    location: "Kowdiar, Thiruvananthapuram",
    client: "Smile Line Dental",
    engineer: "Neethu Thomas",
    budget: 2_600_000,
    startDate: "2026-02-10",
    status: "on-hold",
  },
  {
    id: "hinjewadi-rowhouses",
    name: "Hinjewadi Row Houses",
    location: "Hinjewadi, Pune",
    client: "Deshmukh Realty",
    engineer: "Omkar Patil",
    budget: 7_500_000,
    startDate: "2025-11-03",
    status: "completed",
  },
];

export const WORKERS = [
  "Raju (mason)",
  "Murugan (mason)",
  "Biju (carpenter)",
  "Shankar (bar bender)",
  "Imran (electrician)",
  "Sajeev (plumber)",
  "Ramesh (helper gang)",
  "Lakshmi (helper gang)",
];

export const SUPPLIERS = [
  "Sri Balaji Cements",
  "Kerala Steel Traders",
  "Malabar Sand & Aggregates",
  "Ganesh Hardware",
  "Royal Tiles & Sanitary",
  "Anand Transport",
  "JK Earthmovers",
  "Coastal Paints Depot",
];

export type Template = {
  category: Category;
  description: string;
  quantity?: string;
  min: number;
  max: number;
  supplier?: boolean;
  worker?: boolean;
};

export const TEMPLATES: Template[] = [
  { category: "materials", description: "UltraTech OPC 53 cement", quantity: "100 bags", min: 38_000, max: 46_000, supplier: true },
  { category: "materials", description: "TMT bars Fe500D, 12 mm", quantity: "1.2 t", min: 72_000, max: 88_000, supplier: true },
  { category: "materials", description: "M-sand", quantity: "2 loads", min: 18_000, max: 24_000, supplier: true },
  { category: "materials", description: "20 mm jelly (aggregate)", quantity: "3 units", min: 14_000, max: 19_500, supplier: true },
  { category: "materials", description: "Red bricks", quantity: "4,000 nos", min: 30_000, max: 36_000, supplier: true },
  { category: "materials", description: "Solid blocks, 6 inch", quantity: "600 nos", min: 25_000, max: 31_000, supplier: true },
  { category: "materials", description: "Binding wire and nails", min: 2_400, max: 5_800, supplier: true },
  { category: "materials", description: "PVC pipes and fittings", min: 6_500, max: 14_000, supplier: true },
  { category: "labour", description: "Mason gang daily wage", quantity: "6 workers", min: 6_600, max: 8_400, worker: true },
  { category: "labour", description: "Helpers daily wage", quantity: "8 workers", min: 5_600, max: 7_200, worker: true },
  { category: "labour", description: "Bar bending contract, part payment", min: 25_000, max: 45_000, worker: true },
  { category: "labour", description: "Carpenter, shuttering work", quantity: "3 workers", min: 3_600, max: 4_800, worker: true },
  { category: "labour", description: "Electrician, conduit laying", min: 2_800, max: 6_000, worker: true },
  { category: "transport", description: "Tractor trolley, brick shifting", min: 1_800, max: 3_200, supplier: true },
  { category: "transport", description: "Tipper lorry, sand delivery", min: 4_500, max: 7_000, supplier: true },
  { category: "transport", description: "Pickup van, steel from yard", min: 1_500, max: 2_600, supplier: true },
  { category: "transport", description: "Auto fare, site visits", min: 250, max: 700 },
  { category: "equipment", description: "JCB 3DX hire", quantity: "4 hrs", min: 4_800, max: 6_400, supplier: true },
  { category: "equipment", description: "Concrete mixer rental", quantity: "1 day", min: 1_400, max: 2_000, supplier: true },
  { category: "equipment", description: "Needle vibrator rental", min: 600, max: 900, supplier: true },
  { category: "equipment", description: "Diesel for generator", quantity: "20 L", min: 1_800, max: 2_100 },
  { category: "equipment", description: "Scaffolding pipes rent", quantity: "1 week", min: 3_500, max: 5_500, supplier: true },
  { category: "other", description: "Tea and snacks for crew", min: 300, max: 900 },
  { category: "other", description: "Site security, night watch", min: 700, max: 900 },
  { category: "other", description: "Panchayat permit fee", min: 3_000, max: 8_000 },
  { category: "other", description: "First aid kit and safety helmets", min: 1_200, max: 3_500 },
];

// Small seeded PRNG so the mock data is identical on server and client.
export function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const BILLS: SeedBill[] = [
  { id: "b1", billNo: "SBC/2026/1184", supplier: "Sri Balaji Cements", siteId: "kakkanad-residency", date: "2026-10-16", dueDate: "2026-10-31", amount: 184_500, paid: 0, status: "pending", description: "OPC 53 cement, 420 bags", attachment: { name: "SBC-1184.pdf", size: 248_000, kind: "pdf" } },
  { id: "b2", billNo: "KST-7731", supplier: "Kerala Steel Traders", siteId: "kakkanad-residency", date: "2026-10-04", dueDate: "2026-10-14", amount: 412_800, paid: 200_000, status: "overdue", description: "TMT Fe500D 8/12/16 mm, 5.6 t", attachment: { name: "kst-7731-invoice.jpg", size: 1_840_000, kind: "image" } },
  { id: "b3", billNo: "MSA/442", supplier: "Malabar Sand & Aggregates", siteId: "thrissur-warehouse", date: "2026-10-12", dueDate: "2026-10-27", amount: 96_000, paid: 96_000, status: "paid", description: "M-sand 6 loads, 20 mm jelly 4 units", attachment: { name: "MSA-442.pdf", size: 132_000, kind: "pdf" } },
  { id: "b4", billNo: "GH-20931", supplier: "Ganesh Hardware", siteId: "whitefield-villa", date: "2026-10-18", dueDate: "2026-11-02", amount: 38_740, paid: 0, status: "pending", description: "Binding wire, nails, hinges, PVC fittings" },
  { id: "b5", billNo: "RTS/26/318", supplier: "Royal Tiles & Sanitary", siteId: "anna-nagar-duplex", date: "2026-09-29", dueDate: "2026-10-13", amount: 268_300, paid: 150_000, status: "partial", description: "Vitrified tiles 2x4, 1,800 sq ft", attachment: { name: "royal-tiles-318.jpg", size: 2_210_000, kind: "image" } },
  { id: "b6", billNo: "AT-0912", supplier: "Anand Transport", siteId: "thrissur-warehouse", date: "2026-10-09", dueDate: "2026-10-19", amount: 42_600, paid: 0, status: "overdue", description: "Tipper trips, 14 loads" },
  { id: "b7", billNo: "JKE/1102", supplier: "JK Earthmovers", siteId: "whitefield-villa", date: "2026-10-01", dueDate: "2026-10-15", amount: 57_600, paid: 57_600, status: "paid", description: "JCB 3DX, 48 hrs excavation", attachment: { name: "jke-1102.pdf", size: 98_000, kind: "pdf" } },
  { id: "b8", billNo: "CPD-5520", supplier: "Coastal Paints Depot", siteId: "kowdiar-clinic", date: "2026-08-21", dueDate: "2026-09-05", amount: 74_250, paid: 74_250, status: "paid", description: "Primer and putty, ground floor" },
  { id: "b9", billNo: "SBC/2026/1201", supplier: "Sri Balaji Cements", siteId: "anna-nagar-duplex", date: "2026-10-19", dueDate: "2026-11-03", amount: 61_200, paid: 0, status: "pending", description: "PPC cement, 150 bags", attachment: { name: "SBC-1201.pdf", size: 240_000, kind: "pdf" } },
  { id: "b10", billNo: "KST-7790", supplier: "Kerala Steel Traders", siteId: "thrissur-warehouse", date: "2026-10-14", dueDate: "2026-10-29", amount: 318_900, paid: 0, status: "pending", description: "Structural steel ISMB 200, 3.9 t" },
];
