/**
 * What each site role may do. The server enforces this in src/server/authz.ts;
 * the client imports the same table only to hide controls the server would reject.
 *
 * - owner: everything on the site, including people and invitations.
 * - accountant: money. Expenses (anyone's), bills, payments, budgets, exports.
 * - engineer: field entry. Their own expenses, attendance and receipts. Counted at once.
 * - assistant (assistant engineer): their own expenses only, which count after a site
 *   owner approves them. Sees no totals, budgets, other people's entries, or worker
 *   and supplier records.
 * - viewer: read only.
 *
 * Site owners (and org owners/admins, who are owners everywhere) are the "main engineer":
 * they approve or reject assistants' submissions.
 */

export const SITE_ROLES = ["owner", "accountant", "engineer", "assistant", "viewer"] as const;
export type SiteRole = (typeof SITE_ROLES)[number];

export type SitePermission =
  | "site:read" // the site's figures and records: totals, budgets, everyone's expenses, workers, suppliers
  | "site:manage" // site details and people (members, invitations)
  | "expense:create" // add expenses and their receipts; edit/delete your own expenses
  | "expense:direct" // your expenses count at once, without approval
  | "expense:approve" // approve, reject or reopen submitted expenses
  | "field:record" // attendance, material purchases and usage, labour payments
  | "expense:edit_any"
  | "finance:manage" // budgets, bills, payments, deleting receipts
  | "report:export"
  | "audit:read"; // the site's activity log

const PERMISSIONS: Record<SiteRole, readonly SitePermission[]> = {
  owner: ["site:read", "site:manage", "expense:create", "expense:direct", "expense:approve", "field:record", "expense:edit_any", "finance:manage", "report:export", "audit:read"],
  accountant: ["site:read", "expense:create", "expense:direct", "field:record", "expense:edit_any", "finance:manage", "report:export", "audit:read"],
  engineer: ["site:read", "expense:create", "expense:direct", "field:record"],
  assistant: ["expense:create"],
  viewer: ["site:read"],
};

export function can(role: SiteRole | null | undefined, permission: SitePermission) {
  return !!role && PERMISSIONS[role].includes(permission);
}

export const SITE_ROLE_LABEL: Record<SiteRole, string> = {
  owner: "Owner",
  accountant: "Accountant",
  engineer: "Engineer",
  assistant: "Assistant engineer",
  viewer: "Viewer",
};

export const SITE_ROLE_HINT: Record<SiteRole, string> = {
  owner: "Everything, including people and invitations",
  accountant: "Expenses, bills, payments, budgets and exports",
  engineer: "Adds expenses, attendance and receipts",
  assistant: "Submits expenses for approval; sees only their own",
  viewer: "Read only",
};
