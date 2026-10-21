import type { Metadata } from "next";
import { Suspense } from "react";
import { PageSkeleton } from "@/components/states";
import { VoiceView } from "@/components/views/voice";
import { getVoiceSetup } from "@/server/data/voice";
import { requireActor } from "@/server/session";

export const metadata: Metadata = { title: "Voice entry" };

async function Voice() {
  const actor = await requireActor();
  return <VoiceView setup={await getVoiceSetup(actor)} />;
}

export default function VoicePage() {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <Voice />
    </Suspense>
  );
}
