# Refund reconciliation (manual) — operations guide

CampusPrint never moves money back by itself. During the pilot, refunds for
paid orders that were not completed are arranged between the student and the
shop, and issued by the shop **from its own Razorpay dashboard** (each online
shop has its own merchant account; the money went straight to that shop).
This guide is for the platform operator (admin) who checks that nothing is
forgotten.

## What the states mean

| `payment_status` | Shown as | Meaning |
|---|---|---|
| `PAID` | Paid | Razorpay confirmed the payment (verified webhook or checkout-verify). |
| `REFUND_PENDING` | Paid · not completed | The paid order was cancelled or rejected (set automatically by the database). **No refund has been confirmed.** It is *not* a refund in progress unless the shop has started one. |
| `REFUNDED` | Refunded | Razorpay's signed `refund.processed` event confirmed a refund. Only the payment functions can set this. |

A **refund request** is the student asking the shop (in person, phone, or
message). It is not recorded in CampusPrint.

## Daily review checklist (5 minutes)

1. Run the **daily query** below in the Supabase SQL editor (read-only).
2. For each row older than 2 days, check the shop's Razorpay dashboard
   (Payments → search the `payment_id`, or Orders → `payment_order_id`) — or
   ask the shop to, if you have no access to their account.
3. Classify it (see *Reconciling one order*) and write one line in the
   reconciliation log (see *Recording an investigation*).
4. Rows older than 7 days with no outcome: escalate (see *Escalation*).
5. Also run the **late-payment query** (money captured on an order that was
   already cancelled; the student and shop are notified, but it still needs
   settling) and the **refund-events query** (failed, partial, unexpected or
   unapplied refund events).

### Daily query (read-only)

<!-- daily-query:start -->
```sql
select o.order_number,
       s.name                                  as shop,
       o.status,
       o.status_reason,
       o.total_paise / 100.0                   as amount_rupees,
       o.paid_at,
       o.refunded_paise / 100.0                as refunded_rupees,
       o.refund_requested_at,
       now() - o.refund_requested_at           as waiting,
       o.payment_order_id,
       o.payment_id
  from public.orders o
  join public.shops s on s.id = o.shop_id
 where o.payment_status = 'REFUND_PENDING'
 order by o.refund_requested_at;
```
<!-- daily-query:end -->

### Refund events needing a look (failed, partial, unexpected, unapplied)

<!-- refund-events-query:start -->
```sql
select e.received_at, o.order_number, s.name as shop, e.event_type, e.result,
       e.payload ->> 'refund_id' as refund_id, o.payment_status,
       o.total_paise / 100.0 as total_rupees, o.refunded_paise / 100.0 as refunded_rupees
  from public.payment_events e
  join public.orders o on o.id = e.order_id
  join public.shops s on s.id = o.shop_id
 where e.event_type like 'refund.%'
   and e.result is distinct from 'refunded'
   and e.received_at > now() - interval '30 days'
 order by e.received_at desc;
```
<!-- refund-events-query:end -->

### Late-payment query (paid after the order was cancelled)

<!-- late-payment-query:start -->
```sql
select o.order_number, s.name as shop, o.status, o.status_reason,
       o.cancelled_at, o.paid_at, o.total_paise / 100.0 as amount_rupees, o.payment_id
  from public.orders o
  join public.shops s on s.id = o.shop_id
 where o.payment_status = 'REFUND_PENDING'
   and o.cancelled_at is not null
   and o.paid_at > o.cancelled_at
 order by o.paid_at;
```
<!-- late-payment-query:end -->

### Payment history of one order (read-only)

<!-- order-events-query:start -->
```sql
select e.received_at, e.processed_at, e.event_type, e.event_id, e.payload
  from public.payment_events e
  join public.orders o on o.id = e.order_id
 where o.order_number = 'K-001'   -- replace with the order number
 order by e.received_at;
```
<!-- order-events-query:end -->

## Reconciling one order

Check the payment in the shop's Razorpay dashboard and pick one outcome:

| Razorpay shows | Do |
|---|---|
| No refund | Nothing in the database. Remind the shop; the student may still request one. Log it. |
| Refund **processed**, CampusPrint still says *Paid · not completed* | The `refund.processed` webhook was missed. Ask the shop to confirm their dashboard's webhook points at `/api/payments/razorpay/webhook` with `refund.processed` enabled, then follow *Manual confirmation* below. |
| Refund **pending / initiated** | Wait: Razorpay sends `refund.processed` when it completes. Log it. |
| Refund **failed** | `refund.failed` is recorded (result `refund_failed`) and changes nothing; the order stays *Paid · not completed*. Ask the shop to retry from the dashboard. Log it. |
| **Partial** refund | Recorded in `orders.refunded_paise`; the order stays *Paid · not completed* and the student is told the outstanding amount. It becomes *Refunded* only when verified refunds add up to the full total. Agree the rest with the shop. |
| Refund on an order that was **collected** or is still live | Recorded (`refunded_paise`, result `refund_on_paid_order`); the order stays *Paid*. Confirm with the shop why it was refunded. |
| Refunded outside Razorpay (cash / UPI to the shop) | CampusPrint cannot record this and must not show *Refunded*. Log it with the shop's confirmation and the student's acknowledgement. |
| More than one refund on a payment | Razorpay won't refund more than was captured; check the payment's refund list and raise it with the shop and Razorpay support if amounts look wrong. |

### Manual confirmation (only when Razorpay shows the full refund *processed*)

Two people: one reads the Razorpay dashboard, the other runs the SQL in the
Supabase SQL editor. Use the exact refund id (`rfnd_…`) from Razorpay. This
goes through the same audited function the webhook uses
(`process_payment_event`): it records a `payment_events` row, moves
`REFUND_PENDING → REFUNDED`, sets `refunded_at` and notifies the student.
**Never** `update public.orders set payment_status …` by hand: that skips the
audit row.

```sql
select public.process_payment_event(
  'razorpay',
  'manual:rfnd_XXXXXXXXXXXX',          -- the Razorpay refund id, prefixed manual:
  'refund.processed',
  'order_XXXXXXXXXXXX',                -- orders.payment_order_id
  'pay_XXXXXXXXXXXX',                  -- orders.payment_id
  20000,                               -- THIS refund's amount in paise, exactly as Razorpay shows it
  'INR',
  '{"refund_id": "rfnd_XXXXXXXXXXXX", "source": "manual_reconciliation", "verified_by": "<two sets of staff initials>"}'
);
```

Run it once per Razorpay refund (each has its own `rfnd_…` id). Results:
`refunded` — refunds now cover the total; `partially_refunded` — recorded,
order stays *Paid · not completed*; `duplicate` / `duplicate_refund` — this
refund was already recorded (e.g. the webhook arrived after all), nothing
changed; `refund_exceeds_total`, `refund_unverified`, `refund_amount_invalid`,
`ignored_state` — nothing was applied: stop and investigate.

## Recording an investigation

Until an admin refund queue exists, keep a **reconciliation log** (a shared
sheet with restricted access), one row per check:

`date · order number · shop · Razorpay outcome · refund id (if any) · action · initials`

Never record an outcome by editing `payment_status`, `status_reason` or any
other order field. Only the provider (or *Manual confirmation* above) changes
payment state.

## Protecting customer and payment data

- Identify orders by **order number** only. Don't copy student emails, phone
  numbers, UPI ids or card details into the log, chats or tickets.
- Razorpay dashboard access stays with each shop's account owner and named
  admins. Never share logins or API keys, and never paste keys into chats.
- The SQL editor runs as the database owner: use the read-only queries above;
  run anything else only exactly as written here.
- Screenshots of the Razorpay dashboard: crop to amount, status and ids.

## Escalation

- **> 2 days** pending with no shop response: admin contacts the shop owner.
- **> 7 days** unresolved: admin contacts the student (through the shop or
  CampusPrint support) and agrees a resolution date.
- **Before 30 days**: India's Consumer Protection (E-Commerce) Rules, 2020
  expect complaints to be resolved within one month of receipt — escalate to
  the grievance officer named on the site.
- **Chargeback or bank dispute** (arrives in the shop's Razorpay account): the
  shop responds in Razorpay and tells the admin the same day.

## Customer-facing wording (current, in the app)

- Track page, paid order not completed: *"This order wasn't completed. Your
  payment of ₹X is recorded and has not been refunded yet. To request a
  refund, contact {shop} ({address}). A refund made through Razorpay shows
  here as "Refunded" once Razorpay confirms it; your bank may take a few
  working days to show it."*
- Notification: *"{reason} Your payment is recorded and has not been
  refunded. To request a refund, contact the shop."*
- Cancelling a paid order: *"Cancel this paid order? It is not refunded
  automatically. To request a refund, contact the shop."*
- Paid after cancellation (student): *"Order X was paid after it was cancelled —
  Your payment of ₹X is recorded and has not been refunded. To request a
  refund, contact the shop."* The shop sees it flagged in *Paid, not completed*.
- Partial refund confirmed by Razorpay: *"Razorpay confirmed a refund of ₹A.
  ₹B of your payment has not been refunded; to request it, contact the shop."*
- *"Refund issued … Your money is on its way back to you."* — sent only when
  Razorpay-confirmed refunds cover the full amount.

### Draft public "Cancellation & Refunds" policy (needs legal review before publishing)

Razorpay's website checks expect a published Cancellation & Refunds policy. A
short, honest draft:

> **Cancellation.** You can cancel an order from your order page until the
> shop accepts it or starts printing it. A shop may reject or cancel an order
> it cannot fulfil, and will tell you why.
>
> **Refunds.** If you paid online and your order was not completed, contact
> the shop to request a refund. Refunds are issued by the shop through
> Razorpay to your original payment method; your bank may take several
> working days to show it. Your order page shows *Refunded* once Razorpay
> confirms the refund. Completed orders are not refundable unless the print
> was defective or not as ordered.
>
> **Help.** If a shop does not respond, contact CampusPrint support at
> {support contact}; we acknowledge complaints within 48 hours.
