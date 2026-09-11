import { Suspense } from "react";
import { CardSkeleton } from "@/shared/components";
import TeamPageClient from "./TeamPageClient";

export default function TeamPage() {
  return (
    <Suspense fallback={<CardSkeleton />}>
      <TeamPageClient />
    </Suspense>
  );
}
