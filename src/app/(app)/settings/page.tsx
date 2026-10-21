import type { Metadata } from "next";
import { Suspense } from "react";
import { PageSkeleton } from "@/components/states";
import { SettingsView } from "@/components/views/settings";
import { listMyOrganizations } from "@/server/data/organizations";
import { requireActor } from "@/server/session";

export const metadata: Metadata = { title: "Settings" };

async function Settings() {
  const actor = await requireActor();
  return <SettingsView organizations={await listMyOrganizations(actor)} />;
}

export default function SettingsPage() {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <Settings />
    </Suspense>
  );
}
