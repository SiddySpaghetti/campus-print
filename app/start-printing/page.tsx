import { requireStudentPage } from "@/lib/server/auth";
import { ShopPicker } from "@/components/flow/shop-picker";
import { getListedShops } from "@/lib/shops";

export const metadata = { title: "Choose a print shop" };

export default async function ChooseShopPage({ searchParams }: PageProps<"/start-printing">) {
  // `?shop=<id>` comes from a landing-page "View Shop" link; it only preselects.
  const { shop } = await searchParams;
  const shopId = typeof shop === "string" ? shop : undefined;
  await requireStudentPage(shopId ? `/start-printing?shop=${encodeURIComponent(shopId)}` : "/start-printing");
  return <ShopPicker shops={await getListedShops()} initialShopId={shopId} />;
}
