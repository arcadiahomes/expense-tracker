import { Logo } from "@/components/logo";

export default function AuthLayout({ children }: LayoutProps<"/">) {
  return (
    <main className="grid min-h-dvh place-items-center px-4 py-10">
      <div className="w-full max-w-sm">
        <div className="surface rounded-xl p-6">
          {/* The mark is decorative in Logo, so the name is kept for screen readers. */}
          <div className="mb-6 flex justify-center">
            <Logo className="size-28 sm:size-32" />
            <span className="sr-only">Arcadia Home</span>
          </div>
          {children}
        </div>
      </div>
    </main>
  );
}
