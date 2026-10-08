import { NextResponse } from "next/server";

import { createClient } from "@/utils/supabase/server";

/** POST only: a cross-site page can't sign people out with an <img> or link. */
export async function POST(request: Request) {
  const supabase = await createClient();
  await supabase.auth.signOut();
  return NextResponse.redirect(new URL("/", request.url), { status: 303 });
}
