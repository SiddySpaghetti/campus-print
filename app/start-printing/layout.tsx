import { FlowSteps } from "@/components/flow/flow-steps";
import { PaperBackdrop } from "@/components/flow/paper-backdrop";
import { StudentHeader } from "@/components/shared/student-header";

/**
 * Frame for the whole print flow. Flow state lives in a module-level store
 * (see flow-state.tsx), so it survives navigation between these steps while
 * the header and step rail stay put.
 *
 * StudentHeader sends signed-out visitors to /login and non-students home.
 * This is a convenience, not the security boundary: every API route re-checks
 * the user and role itself.
 */
export default function StartPrintingLayout({ children }: LayoutProps<"/start-printing">) {
  return (
    <div className="relative isolate flex min-h-dvh flex-col">
      <PaperBackdrop />
      <StudentHeader next="/start-printing">
        <FlowSteps />
      </StudentHeader>
      <main id="main" className="flex-1">
        {children}
      </main>
    </div>
  );
}
