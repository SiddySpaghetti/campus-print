import { requireStudentPage } from "@/lib/server/auth";
import { ShopPicker } from "@/components/flow/shop-picker";
import { getListedShops } from "@/lib/shops";

export default async function ChooseShopPage() {
  await requireStudentPage("/start-printing");
  return <ShopPicker shops={await getListedShops()} />;
}
