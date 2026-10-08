import type { OrderStatus } from "@/components/flow/order-tracker";
import { AutoRefresh } from "@/components/flow/order-actions";
import { Container } from "@/components/shared/section";
import { StaffHeader } from "@/components/shared/staff-header";
import { formatOrderDate, orderLabel, paymentLabel, statusLabels } from "@/lib/orders";
import { formatRupees } from "@/lib/pricing";
import { requireRolePage } from "@/lib/server/auth";

type AdminOrder = {
  id: string;
  order_number: string | null;
  shop_id: string;
  status: OrderStatus;
  payment_status: string;
  payment_method: string;
  total_paise: number;
  created_at: string;
};
type AdminShop = { id: string; name: string; is_verified: boolean; is_open: boolean; prep_minutes: number; deleted_at: string | null };
type AdminProfile = { id: string; role: string; full_name: string | null; shop_id: string | null; created_at: string; deleted_at: string | null };

export const metadata = { title: "Admin · CampusPrint" };

const th = "px-3 py-2 text-left font-mono text-[11px] font-medium uppercase tracking-[0.1em] text-muted-foreground";
const td = "px-3 py-2 text-[13px] text-ink";

/**
 * Read-only platform overview. Runs AS the admin user, so the admin RLS
 * policies (is_admin(), from public.profiles — never the browser or JWT
 * metadata) are what grant access; no service-role key is used. Users are
 * shown by role, name and a short id only: no emails, phones or auth data.
 */
export default async function AdminPage() {
  const { supabase, user } = await requireRolePage("admin", "/admin");

  const [{ data: shopsData }, { data: ordersData }, { data: profilesData }] = await Promise.all([
    supabase.from("shops").select("id, name, is_verified, is_open, prep_minutes, deleted_at").order("sort_order").returns<AdminShop[]>(),
    supabase
      .from("orders")
      .select("id, order_number, shop_id, status, payment_status, payment_method, total_paise, created_at")
      .order("created_at", { ascending: false })
      .limit(500)
      .returns<AdminOrder[]>(),
    supabase.from("profiles").select("id, role, full_name, shop_id, created_at, deleted_at").order("created_at").returns<AdminProfile[]>(),
  ]);
  const shops = shopsData ?? [];
  const orders = ordersData ?? [];
  const profiles = profilesData ?? [];
  const shopName = new Map(shops.map((s) => [s.id, s.name]));

  const byStatus = (Object.keys(statusLabels) as OrderStatus[]).map((s) => [s, orders.filter((o) => o.status === s).length] as const);
  const byRole = ["student", "shopkeeper", "admin"].map((r) => [r, profiles.filter((p) => p.role === r && !p.deleted_at).length] as const);
  const completedValue = orders.filter((o) => o.status === "COMPLETED").reduce((sum, o) => sum + o.total_paise, 0);

  return (
    <div className="flex min-h-dvh flex-col">
      <AutoRefresh />
      <StaffHeader area="Admin" email={user.email} />
      <main id="main">
        <Container className="pb-16 pt-8 md:pt-12">
          <h1 className="font-display text-3xl font-semibold tracking-[-0.02em] text-ink">Platform overview</h1>
          <p className="mt-1 text-[13px] text-muted-foreground">Counts cover the latest {orders.length} orders.</p>

          <dl className="mt-6 grid grid-cols-2 gap-2 sm:grid-cols-4">
            <Stat label="Orders" value={orders.length} />
            <Stat label="Completed value" value={formatRupees(completedValue / 100)} />
            {byRole.map(([r, n]) => (
              <Stat key={r} label={`${r}s`} value={n} />
            ))}
            {byStatus.map(([s, n]) => (
              <Stat key={s} label={statusLabels[s]} value={n} />
            ))}
          </dl>

          <Table title="Shops" head={["Name", "Verified", "Open", "Prep", "Status"]}>
            {shops.map((s) => (
              <tr key={s.id} className="border-t border-line">
                <td className={td}>{s.name}</td>
                <td className={td}>{s.is_verified ? "Yes" : "No"}</td>
                <td className={td}>{s.is_open ? "Open" : "Closed"}</td>
                <td className={td}>{s.prep_minutes} min</td>
                <td className={td}>{s.deleted_at ? "Deleted" : "Active"}</td>
              </tr>
            ))}
          </Table>

          <Table title="Recent orders" head={["Order", "Shop", "Status", "Payment", "Total", "Placed"]}>
            {orders.slice(0, 100).map((o) => (
              <tr key={o.id} className="border-t border-line">
                <td className={`${td} font-mono`}>#{orderLabel(o)}</td>
                <td className={td}>{shopName.get(o.shop_id) ?? "—"}</td>
                <td className={td}>{statusLabels[o.status]}</td>
                <td className={td}>{paymentLabel(o)}</td>
                <td className={`${td} font-mono`}>{formatRupees(o.total_paise / 100)}</td>
                <td className={td}>{formatOrderDate(o.created_at)}</td>
              </tr>
            ))}
          </Table>

          <Table title="Users" head={["User", "Role", "Name", "Shop", "Joined"]}>
            {profiles.map((p) => (
              <tr key={p.id} className="border-t border-line">
                <td className={`${td} font-mono`}>{p.id.slice(0, 8)}</td>
                <td className={td}>{p.deleted_at ? `${p.role} (deleted)` : p.role}</td>
                <td className={td}>{p.full_name ?? "—"}</td>
                <td className={td}>{p.shop_id ? (shopName.get(p.shop_id) ?? "—") : "—"}</td>
                <td className={td}>{formatOrderDate(p.created_at)}</td>
              </tr>
            ))}
          </Table>
        </Container>
      </main>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded-card border border-line bg-card p-3">
      <dt className="text-[12px] capitalize text-muted-foreground">{label}</dt>
      <dd className="font-mono text-xl font-semibold text-ink">{value}</dd>
    </div>
  );
}

function Table({ title, head, children }: { title: string; head: string[]; children: React.ReactNode }) {
  return (
    <section className="mt-10">
      <h2 className="text-lg font-semibold text-ink">{title}</h2>
      <div className="mt-3 overflow-x-auto rounded-card border border-line bg-card">
        <table className="w-full min-w-[560px]">
          <thead>
            <tr>
              {head.map((h) => (
                <th key={h} scope="col" className={th}>
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>{children}</tbody>
        </table>
      </div>
    </section>
  );
}
