"use client";

import { ErrorState } from "@/components/states";

export default function Error({ reset }: { error: Error; reset: () => void }) {
  return (
    <ErrorState
      title="This screen hit a problem"
      description="Something went wrong while showing this page. Your saved entries are safe."
      onRetry={reset}
    />
  );
}
