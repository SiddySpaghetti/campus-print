import { Footer } from "@/components/landing/footer";
import { Navbar } from "@/components/landing/navbar";
import { Hero } from "@/components/landing/hero";
import { HowItWorks } from "@/components/landing/how-it-works";
import { PrintShops } from "@/components/landing/print-shops";

// Only the landing page is canonical-tagged: set in the root layout, every
// page would inherit "/" as its canonical URL.
export const metadata = { alternates: { canonical: "/" } };

export default function Home() {
  return (
    <>
      <Navbar />
      <main id="main" className="flex-1">
        <Hero />
        <HowItWorks />
        <PrintShops />
      </main>
      <Footer />
    </>
  );
}
