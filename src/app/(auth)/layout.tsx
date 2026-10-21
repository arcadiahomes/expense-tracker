import { Logo } from "@/components/logo";

export default function AuthLayout({ children }: LayoutProps<"/">) {
  return (
    <main className="grid min-h-dvh place-items-center px-4 py-10">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex items-center gap-3">
          <Logo className="size-10" />
          <div className="leading-tight">
            <p className="font-display text-lg font-extrabold">Arcadia Home</p>
            <p className="text-xs text-muted-foreground">Site expenses ERP</p>
          </div>
        </div>
        <div className="surface rounded-xl p-6">{children}</div>
      </div>
    </main>
  );
}
