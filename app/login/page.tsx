import Link from "next/link";
import { redirect } from "next/navigation";

import { LoginForm } from "@/app/login/login-form";
import { Logo } from "@/components/shared/logo";
import { Container } from "@/components/shared/section";
import { safeNextPath } from "@/lib/server/validate";
import { createClient } from "@/utils/supabase/server";

export default async function LoginPage({ searchParams }: PageProps<"/login">) {
  const params = await searchParams;
  const next = safeNextPath(params.next);

  const supabase = await createClient();
  const { data } = await supabase.auth.getUser();
  if (data.user) redirect(next);

  return (
    <Container className="flex min-h-dvh flex-col items-center justify-center py-16">
      <Link href="/" aria-label="CampusPrint home" className="mb-10">
        <Logo />
      </Link>
      <div className="w-full max-w-sm rounded-card border border-line bg-card p-6">
        <h1 className="font-display text-2xl font-semibold tracking-[-0.02em] text-ink">
          Sign in to print
        </h1>
        <p className="mt-1.5 text-[14px] text-muted-foreground">
          We&apos;ll email you a one-time sign-in link. No password needed.
        </p>
        {params.error ? (
          <p role="alert" className="mt-4 text-[13px] font-medium text-destructive">
            That sign-in link is invalid or has expired. Request a new one.
          </p>
        ) : null}
        <LoginForm next={next} />
      </div>
    </Container>
  );
}
