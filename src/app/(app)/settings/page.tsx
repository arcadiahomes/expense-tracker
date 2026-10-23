import type { Metadata } from "next";
import { Suspense } from "react";
import { PageSkeleton } from "@/components/states";
import { SettingsView } from "@/components/views/settings";
import { listMyOrganizations, organizationProfile } from "@/server/data/organizations";
import { isOrgAdmin } from "@/server/authz";
import { requireActor } from "@/server/session";

export const metadata: Metadata = { title: "Settings" };

async function Settings() {
  const actor = await requireActor();
  const [organizations, company] = await Promise.all([listMyOrganizations(actor), isOrgAdmin(actor) ? organizationProfile(actor) : null]);
  return <SettingsView organizations={organizations} company={company} />;
}

export default function SettingsPage() {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <Settings />
    </Suspense>
  );
}
