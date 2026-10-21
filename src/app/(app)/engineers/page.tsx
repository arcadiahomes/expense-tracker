import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { Suspense } from "react";
import { PageSkeleton } from "@/components/states";
import { EngineersView } from "@/components/views/engineers";
import { isAdmin } from "@/server/authz";
import { listAccounts } from "@/server/data/accounts";
import { requireRecordsReader } from "@/server/session";

export const metadata: Metadata = { title: "Assistant engineers" };

async function Engineers() {
  const actor = await requireRecordsReader();
  // Accounts are the admin's alone; the data layer refuses everyone else too.
  if (!isAdmin(actor)) redirect("/");
  return <EngineersView accounts={await listAccounts(actor)} />;
}

export default function EngineersPage() {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <Engineers />
    </Suspense>
  );
}
