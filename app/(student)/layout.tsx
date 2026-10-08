import { PaperBackdrop } from "@/components/flow/paper-backdrop";
import { StudentHeader } from "@/components/shared/student-header";

/**
 * Signed-in student pages outside the print flow: My orders, notifications.
 * Each page guards itself (requireStudentPage) so login returns to it.
 */
export default function StudentLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="relative isolate flex min-h-dvh flex-col">
      <PaperBackdrop />
      <StudentHeader />
      <main id="main" className="flex-1">
        {children}
      </main>
    </div>
  );
}
