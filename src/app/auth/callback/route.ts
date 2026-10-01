import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

// Email confirmation links land here with a one-time code.
export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get("code");
  if (code) {
    const supabase = await createClient();
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) return NextResponse.redirect(`${origin}/trade`);
  }
  return NextResponse.redirect(`${origin}/login`);
}
