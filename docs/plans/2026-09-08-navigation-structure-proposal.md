# Navigation structure: what is confusing, and a proposal

Status: proposal, not built. Written because "improve navigation" cannot be
reviewed or finished as stated — this is the thing to argue with.

## The structure today

Main sidebar:

```
ESSENTIALS       Overview
INFRASTRUCTURE   Drive
ACCOUNT          Subscription Plans, Billing, Wallet*, Referrals*
SUPPORT          Documentation, Help & Support
```

Settings (its own sidebar, reached from the user menu):

```
Sync & Storage, Wallets, Security, Notifications, Appearance,
API Token, Updates, VPN Settings*, Customize RPC
```

`*` gated off in production today (`WALLET_FEATURE_ENABLED`,
`REFERRALS_FEATURE_ENABLED`, `VPN_FEATURE_ENABLED`).

## What is actually confusing

**1. Section headings that carry one item each.** With the flags as they
ship, ESSENTIALS holds one item, INFRASTRUCTURE holds one item, and ACCOUNT
holds two. Four headings for five destinations is heading-per-item: the
grouping conveys nothing and costs a row of vertical space each.
INFRASTRUCTURE is the clearest case — a category name borrowed from cloud
consoles wrapped around a single link named Drive.

**2. Two places mean "my storage" and neither says so.** Drive is the files.
Settings → Sync & Storage is which local folders sync and how. A user
looking for "where are my synced folders" can reasonably open either, and
Drive is the one that does not answer it.

**3. Two places mean "my money".** Subscription Plans and Billing are
adjacent siblings covering one subject split by tense — what you could buy
versus what you have paid. Wallet is a third money-adjacent item that is not
about paying for Hippius at all. (The plans/billing half of this is already
being addressed: plan detail is moving under Billing, and Billing into
Settings.)

**4. Wallets appears twice, meaning different things.** ACCOUNT → Wallet is
the chain wallet page; Settings → Wallets is local wallet management. Same
word, two destinations, both currently gated off — which is the only reason
it is not biting yet.

**5. Settings is a flat list of nine unrelated items.** Sync, security,
appearance, API tokens, updates and RPC endpoints sit at one level in
arrival order. Nothing tells a user that Appearance is a preference and
Customize RPC is closer to a developer setting.

**6. Nothing marks the account's state.** The sidebar looks identical
whether an account is on the free tier or paying, and whether storage is
empty or nearly full. The one place that state shows is the plan chip in the
page header, which is easy to miss.

## Proposal

**Collapse the top three groups into one unlabelled list.** Overview, Drive,
then whatever account items survive the billing move. Headings earn their
space at roughly four or more items; below that they are noise. This removes
INFRASTRUCTURE and the Confidential Computing shape it was built for (that
entry is already gone), and it removes ESSENTIALS, which never distinguished
anything.

**Let Drive own storage.** Sync & Storage is the setup screen for the thing
Drive shows. It should be reachable from Drive — a "Manage folders" affordance
near the drive picker — not only from a different sidebar. Keep the Settings
entry as well; the point is that the Drive route should exist at all.

**One money destination.** With plans folded into Billing and Billing moved
to Settings, the sidebar should have no money item at all for a subscribed
account, and exactly one prominent route to subscribe for an account without
a plan. That is the direction already agreed; this proposal only adds that
Wallet must not be reintroduced next to it under a name a user will read as
billing. If the chain wallet returns, it belongs under Settings → Wallets
with the local wallets, or renamed to something unmistakably chain-related.

**Group Settings into three.** Roughly: *Your account* (Security, Wallets,
API Token), *Your app* (Sync & Storage, Notifications, Appearance, Updates),
*Advanced* (Customize RPC, VPN when it returns). Nine flat items is where a
list stops being scannable.

**Show plan and usage in the sidebar footer.** The plan chip and a thin
storage bar, sitting above the user menu. This is the cheapest fix for point
6, it gives the upgrade prompt a permanent home that is not a page header,
and the data is already computed — `get_storage_overview` returns used,
total and percentage in one call.

## What this proposal does not settle

- Whether Overview earns a place once the sidebar carries plan and usage.
  It may become the least-visited item in the app.
- Where shared drives land when they launch. They are neither a Drive nor an
  account concept and will need a home rather than being appended to one.
- Whether Documentation and Help & Support need a SUPPORT heading, or work as
  two items at the bottom of a single list.
