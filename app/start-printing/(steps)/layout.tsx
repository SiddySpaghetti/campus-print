import { requireStudentPage } from "@/lib/server/auth";

/**
 * Guard for the client-component steps (upload, options, review), which can't
 * call requireStudentPage themselves. Their state lives in memory, so after
 * signing in the student restarts at step one.
 */
export default async function FlowStepsLayout({ children }: { children: React.ReactNode }) {
  await requireStudentPage("/start-printing");
  return children;
}
