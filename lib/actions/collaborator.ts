"use server";

import { headers } from "next/headers";
import { auth } from "@/lib/auth";
import { getInstallationRepos, getInstallations } from "@/lib/github-app";
import { requireGithubRepoWriteAccess } from "@/lib/authz-server";
import { InviteEmailTemplate } from "@/components/email/invite";
import { render } from "@react-email/render";
import { sendEmail } from "@/lib/mailer";
import { getBaseUrl } from "@/lib/base-url";
import { db } from "@/db";
import { and, eq, sql } from "drizzle-orm";
import { accountTable, sessionTable, userTable, collaboratorInviteTable, collaboratorTable } from "@/db/schema";
import { z } from "zod";
import { randomBytes, randomUUID } from "crypto";
import { normalizeEmail } from "@/lib/collaborator-access";

import { requireAdminSession, isBootstrapAdminEmail } from "@/lib/admin";

const assertRepoInInstallation = async (
  user: { id: string; githubUsername?: string | null },
  owner: string,
  repo: string
) => {
  const { token, repoAccess } = await requireGithubRepoWriteAccess(
    user,
    owner,
    repo,
    "You must be signed in with GitHub to manage collaborators.",
  );
  const installations = await getInstallations(token, [owner]);
  if (installations.length !== 1) throw new Error(`"${owner}" is not part of your GitHub App installations`);
  const installationRepos = await getInstallationRepos(token, installations[0].id);
  const isInstalledForRepo = installationRepos.some((installationRepo) =>
    installationRepo.id === repoAccess.repoId ||
    (
      installationRepo.owner?.login?.toLowerCase() === owner.toLowerCase() &&
      installationRepo.name?.toLowerCase() === repo.toLowerCase()
    )
  );
  if (!isInstalledForRepo) throw new Error(`"${owner}/${repo}" is not part of your Pages CMS installation.`);

  return {
    repoAccess,
    installation: installations[0],
  };
};

const generateInviteToken = () => {
  const alphabet = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
  const bytes = randomBytes(32);
  let token = "";

  for (let i = 0; i < 32; i += 1) {
    token += alphabet[bytes[i] % alphabet.length];
  }

  return token;
};

const createCollaboratorInviteUrl = async ({
  email,
  owner,
  repo,
  baseUrl,
}: {
  email: string;
  owner: string;
  repo: string;
  baseUrl: string;
}) => {
  const token = generateInviteToken();
  const expiresAt = new Date(
    Date.now() + ((Number(process.env.COLLABORATOR_INVITE_LINK_EXPIRES_IN) || 86400) * 1000),
  );

  await db
    .delete(collaboratorInviteTable)
    .where(
      and(
        sql`lower(${collaboratorInviteTable.email}) = lower(${email})`,
        sql`lower(${collaboratorInviteTable.owner}) = lower(${owner})`,
        sql`lower(${collaboratorInviteTable.repo}) = lower(${repo})`,
      ),
    );

  await db.insert(collaboratorInviteTable).values({
    token,
    email,
    owner,
    repo,
    expiresAt,
  });

  const inviteUrl = new URL("/sign-in/collaborator", baseUrl);
  inviteUrl.searchParams.set("token", token);

  return inviteUrl.toString();
};

// Provision one account and repository membership atomically. Existing credentials
// are never replaced by adding access to another repository.
const handleAddCollaborator = async (_prevState: unknown, formData: FormData) => {
  try {
    const { user } = await requireAdminSession();
    const input = z.object({
      owner: z.string().trim().min(1),
      repo: z.string().trim().min(1),
      email: z.string().trim().email().transform(normalizeEmail),
      password: z.string().max(128).refine(value => value === "" || value.length >= 12,
        "Use at least 12 characters for the password."),
    }).parse(Object.fromEntries(formData));
    const { repoAccess, installation } = await assertRepoInInstallation(user, input.owner, input.repo);
    if (isBootstrapAdminEmail(input.email)) {
      throw new Error("Administrator accounts must use GitHub sign-in.");
    }
    const context = await auth.$context;
    const hash = input.password ? await context.password.hash(input.password) : null;
    const collaborator = await db.transaction(async (tx) => {
      // Serialize provisioning/reset of the same email, including across repositories.
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${input.email}))`);
      let target = await tx.query.userTable.findFirst({
        where: sql`lower(${userTable.email}) = ${input.email}`,
      });
      if (!target) {
        if (!hash) throw new Error("Enter a password for the new account.");
        [target] = await tx.insert(userTable).values({
          id: randomUUID(), name: input.email, email: input.email, emailVerified: false,
        }).returning();
        await tx.insert(accountTable).values({
          id: randomUUID(), userId: target.id, accountId: target.id,
          providerId: "credential", password: hash,
        });
      } else if (hash) {
        throw new Error("This account already exists. Leave password blank to add access, then use Set password if needed.");
      }
      const existing = await tx.query.collaboratorTable.findFirst({
        where: and(eq(collaboratorTable.repoId, repoAccess.repoId),
          eq(collaboratorTable.ownerId, repoAccess.ownerId),
          sql`lower(${collaboratorTable.email}) = ${input.email}`),
      });
      const membership = { userId: target.id, invitedBy: user.id };
      const [result] = existing
        ? await tx.update(collaboratorTable).set(membership)
          .where(eq(collaboratorTable.id, existing.id)).returning()
        : await tx.insert(collaboratorTable).values({
          ...membership, type: repoAccess.ownerType, installationId: installation.id,
          ownerId: repoAccess.ownerId, repoId: repoAccess.repoId,
          owner: repoAccess.ownerLogin, repo: repoAccess.repoName, email: input.email,
        }).returning();
      await tx.delete(collaboratorInviteTable).where(and(
        sql`lower(${collaboratorInviteTable.email}) = ${input.email}`,
        sql`lower(${collaboratorInviteTable.owner}) = lower(${input.owner})`,
        sql`lower(${collaboratorInviteTable.repo}) = lower(${input.repo})`,
      ));
      return result;
    });
    return { message: `${input.email} now has access to ${input.owner}/${input.repo}. Share login details directly.`, data: [collaborator] };
  } catch (error) {
    return { error: error instanceof z.ZodError ? error.issues[0].message
      : error instanceof Error ? error.message : "Could not add collaborator." };
  }
};

const handleSetCollaboratorPassword = async (_prevState: unknown, formData: FormData) => {
  try {
    const { user } = await requireAdminSession();
    const input = z.object({
      owner: z.string().trim().min(1), repo: z.string().trim().min(1),
      collaboratorId: z.coerce.number().int().positive(),
      password: z.string().min(12).max(128),
    }).parse(Object.fromEntries(formData));
    const { repoAccess } = await assertRepoInInstallation(user, input.owner, input.repo);
    const context = await auth.$context;
    const hash = await context.password.hash(input.password);
    await db.transaction(async (tx) => {
      const collaborator = await tx.query.collaboratorTable.findFirst({
        where: and(eq(collaboratorTable.id, input.collaboratorId),
          eq(collaboratorTable.ownerId, repoAccess.ownerId),
          eq(collaboratorTable.repoId, repoAccess.repoId)),
      });
      if (!collaborator) throw new Error("Collaborator not found in this repository.");
      if (isBootstrapAdminEmail(collaborator.email)) {
        throw new Error("Administrator accounts must use GitHub sign-in.");
      }
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${normalizeEmail(collaborator.email)}))`);
      let target = await tx.query.userTable.findFirst({
        where: collaborator.userId ? eq(userTable.id, collaborator.userId)
          : sql`lower(${userTable.email}) = lower(${collaborator.email})`,
      });
      if (!target) {
        [target] = await tx.insert(userTable).values({
          id: randomUUID(), name: collaborator.email, email: normalizeEmail(collaborator.email), emailVerified: false,
        }).returning();
      }
      if (isBootstrapAdminEmail(target.email)) throw new Error("Administrator accounts must use GitHub sign-in.");
      const credentials = await tx.query.accountTable.findFirst({
        where: and(eq(accountTable.userId, target.id), eq(accountTable.providerId, "credential")),
      });
      if (credentials) {
        await tx.update(accountTable).set({ password: hash, updatedAt: new Date() })
          .where(eq(accountTable.id, credentials.id));
      } else {
        await tx.insert(accountTable).values({
          id: randomUUID(), userId: target.id, accountId: target.id, providerId: "credential", password: hash,
        });
      }
      await tx.update(collaboratorTable).set({ userId: target.id })
        .where(eq(collaboratorTable.id, collaborator.id));
      await tx.delete(sessionTable).where(eq(sessionTable.userId, target.id));
    });
    return { message: "Password saved. Existing sessions have been signed out." };
  } catch (error) {
    return { error: error instanceof z.ZodError ? "Use a password between 12 and 128 characters."
      : error instanceof Error ? error.message : "Could not set password." };
  }
};

// Remove a collaborator from a repository.
const handleRemoveCollaborator = async (collaboratorId: number, owner: string, repo: string) => {
	try {
		const session = await auth.api.getSession({
      headers: await headers(),
    });
    const user = session?.user;
		if (!user) throw new Error("You must be signed in with GitHub to invite collaborators.");

		const collaborator = await db.query.collaboratorTable.findFirst({ where: eq(collaboratorTable.id, collaboratorId) });
		if (!collaborator) throw new Error("Collaborator not found");

    const { repoAccess } = await assertRepoInInstallation(user, owner, repo);

		const deletedCollaborator = await db.delete(collaboratorTable).where(
			and(
				eq(collaboratorTable.id, collaboratorId),
				eq(collaboratorTable.repoId, repoAccess.repoId)
			)
		).returning();

		if (!deletedCollaborator || deletedCollaborator.length === 0) throw new Error("Failed to delete collaborator");

    await db
      .delete(collaboratorInviteTable)
      .where(
        and(
          sql`lower(${collaboratorInviteTable.email}) = lower(${collaborator.email})`,
          sql`lower(${collaboratorInviteTable.owner}) = lower(${owner})`,
          sql`lower(${collaboratorInviteTable.repo}) = lower(${repo})`,
        ),
      );

		return { message: `Invitation to ${collaborator.email} for "${owner}/${repo}" successfully removed.` };
	} catch (error: any) {
		console.error(error);
		return { error: error.message };
	}
};

const handleResendCollaboratorInvite = async (collaboratorId: number, owner: string, repo: string) => {
  try {
    const session = await auth.api.getSession({
      headers: await headers(),
    });
    const user = session?.user;
    if (!user) throw new Error("You must be signed in with GitHub to resend collaborator invites.");
    await assertRepoInInstallation(user, owner, repo);

    const collaborator = await db.query.collaboratorTable.findFirst({ where: eq(collaboratorTable.id, collaboratorId) });
    if (!collaborator) throw new Error("Collaborator not found");

    if (collaborator.owner.toLowerCase() !== owner.toLowerCase() || collaborator.repo.toLowerCase() !== repo.toLowerCase()) {
      throw new Error("Collaborator does not belong to this repository.");
    }

    const baseUrl = getBaseUrl();
    const inviteUrl = await createCollaboratorInviteUrl({
      email: collaborator.email,
      owner,
      repo,
      baseUrl,
    });

    const html = await render(
      InviteEmailTemplate({
        inviteUrl,
        repoName: `${owner}/${repo}`,
        email: collaborator.email,
        invitedByName: user.name || user.githubUsername || user.email,
        invitedByUrl: `https://github.com/${user.githubUsername}`,
      }),
    );

    await sendEmail({
      to: collaborator.email,
      subject: `Join "${owner}/${repo}" on Pages CMS`,
      html,
    });

    return { message: `Invitation email resent to ${collaborator.email}.` };
  } catch (error: any) {
    console.error(error);
    return { error: error.message };
  }
};

export { handleAddCollaborator, handleRemoveCollaborator, handleResendCollaboratorInvite, handleSetCollaboratorPassword };
