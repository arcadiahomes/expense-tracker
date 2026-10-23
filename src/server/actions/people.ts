"use server";

import { createAccount, issuePasswordLink, setAccountActive, setAccountSites } from "../data/accounts";
import { selectOrganization, updateOrganizationProfile } from "../data/organizations";
import { removeSiteMember, setSiteMemberRole } from "../data/sites";
import { run } from "./run";

export async function createAccountAction(input: unknown) {
  return run((actor) => createAccount(actor, input));
}

export async function setAccountSitesAction(input: unknown) {
  return run((actor) => setAccountSites(actor, input));
}

export async function setAccountActiveAction(input: unknown) {
  return run((actor) => setAccountActive(actor, input));
}

export async function issuePasswordLinkAction(userId: string) {
  return run((actor) => issuePasswordLink(actor, userId));
}

export async function setSiteMemberRoleAction(input: unknown) {
  return run((actor) => setSiteMemberRole(actor, input));
}

export async function removeSiteMemberAction(siteId: string, userId: string) {
  return run((actor) => removeSiteMember(actor, siteId, userId));
}

export async function selectOrganizationAction(id: string) {
  return run((actor) => selectOrganization(actor, id));
}

export async function updateOrganizationProfileAction(input: unknown) {
  return run((actor) => updateOrganizationProfile(actor, input));
}
