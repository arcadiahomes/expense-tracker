import { sql } from "drizzle-orm";
import {
  date,
  index,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { SITE_ROLES } from "../../lib/permissions";
import { users } from "./auth";

export const orgRole = pgEnum("org_role", ["owner", "admin", "member"]);
export const siteRole = pgEnum("site_role", SITE_ROLES);
export const siteStatus = pgEnum("site_status", ["active", "on_hold", "completed"]);

/** Tenant root: a construction company. */
export const organizations = pgTable("organizations", {
  id: uuid().primaryKey().defaultRandom(),
  name: text().notNull(),
  slug: text().notNull().unique(),
  /** Company details printed on invoices and receipts; all optional, set by an org owner or admin. */
  address: text(),
  phone: text(),
  email: text(),
  website: text(),
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
});

export const organizationMembers = pgTable(
  "organization_members",
  {
    organizationId: uuid()
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    userId: text()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: orgRole().notNull().default("member"),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    /** Set when the user switches to this organization; the latest one is their active workspace. */
    selectedAt: timestamp({ withTimezone: true }),
  },
  (t) => [
    primaryKey({ columns: [t.organizationId, t.userId] }),
    index().on(t.userId),
    // The organization owner is the one permanent admin. A trigger (migration 0012) also
    // refuses removing, demoting or deactivating them.
    uniqueIndex("organization_members_one_owner").on(t.organizationId).where(sql`role = 'owner'`),
  ],
);

export const constructionSites = pgTable(
  "construction_sites",
  {
    id: uuid().primaryKey().defaultRandom(),
    organizationId: uuid()
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    name: text().notNull(),
    location: text().notNull(),
    clientName: text(),
    status: siteStatus().notNull().default("active"),
    startDate: date({ mode: "string" }).notNull(),
    endDate: date({ mode: "string" }),
    createdBy: text()
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [unique().on(t.organizationId, t.name), index().on(t.organizationId, t.status)],
);

/** Per-site access. Org owners/admins get site owner rights without a row here. */
export const siteMemberships = pgTable(
  "site_memberships",
  {
    siteId: uuid()
      .notNull()
      .references(() => constructionSites.id, { onDelete: "cascade" }),
    userId: text()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: siteRole().notNull().default("viewer"),
    addedBy: text().references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.siteId, t.userId] }), index().on(t.userId)],
);

/**
 * An invitation to join an organization with roles on selected sites.
 * Only the SHA-256 of the token is stored; the token itself is shown once to the inviter.
 */
export const invitations = pgTable(
  "invitations",
  {
    id: uuid().primaryKey().defaultRandom(),
    organizationId: uuid()
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    /** Lowercased. Only an account with this email can accept. */
    email: text().notNull(),
    tokenHash: text().notNull().unique(),
    invitedBy: text().references(() => users.id, { onDelete: "set null" }),
    expiresAt: timestamp({ withTimezone: true }).notNull(),
    acceptedAt: timestamp({ withTimezone: true }),
    acceptedBy: text().references(() => users.id, { onDelete: "set null" }),
    revokedAt: timestamp({ withTimezone: true }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index().on(t.organizationId), index().on(t.email)],
);

export const invitationSites = pgTable(
  "invitation_sites",
  {
    invitationId: uuid()
      .notNull()
      .references(() => invitations.id, { onDelete: "cascade" }),
    siteId: uuid()
      .notNull()
      .references(() => constructionSites.id, { onDelete: "cascade" }),
    role: siteRole().notNull(),
  },
  (t) => [primaryKey({ columns: [t.invitationId, t.siteId] }), index().on(t.siteId)],
);
