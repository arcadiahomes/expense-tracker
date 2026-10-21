import Link from "next/link";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export default function NotFound() {
  return (
    <div className="flex flex-col items-center py-20 text-center">
      <p className="font-display text-5xl font-bold">404</p>
      <p className="mt-2 text-muted-foreground">There&rsquo;s no page at this address.</p>
      <Link href="/" className={cn(buttonVariants(), "mt-5 h-11 px-5")}>Go to dashboard</Link>
    </div>
  );
}
