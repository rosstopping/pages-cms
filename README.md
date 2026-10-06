# Pages CMS

[Pages CMS](https://pagescms.org) is an open source CMS for GitHub repositories. It is especially well suited for static sites and content-driven apps built with tools like Jekyll, Hugo, Next.js, Astro, VuePress, and similar stacks.

You can use the hosted version directly at [app.pagescms.org](https://app.pagescms.org), or run your own local development copy from this repository.

[![Screenshot of the Pages CMS editor](https://pagescms.org/media/screenshot.png)](https://demo.pagescms.org)

*[Watch the demo ▶](https://demo.pagescms.org)*

## Documentation

Full documentation lives at [pagescms.org/docs](https://pagescms.org/docs).

Useful starting points:

- [Install locally](https://pagescms.org/docs/guides/installing/)
- [Create the GitHub App](https://pagescms.org/docs/guides/installing/github-app/)
- [Environment variables](https://pagescms.org/docs/development/environment-variables/)
- [Upgrading to 2.x](https://pagescms.org/docs/guides/upgrading-to-2/)

## Use online

The easiest way to get started is the hosted version at [app.pagescms.org](https://app.pagescms.org).

Use that if you want to:

- try Pages CMS immediately,
- edit content without running anything locally,
- stay on the latest hosted version.

## Local development

### What you need

- PostgreSQL
- a GitHub App
- a local `.env.local`
- the Pages CMS repo checked out locally

### Quick start

1. Clone the repository:

```bash
git clone https://github.com/pagescms/pagescms.git
cd pagescms
```

2. Start PostgreSQL locally:

```bash
docker run --name pagescms-db -e POSTGRES_USER=pagescms -e POSTGRES_PASSWORD=pagescms -e POSTGRES_DB=pagescms -p 5432:5432 -d postgres:16
```

3. Install dependencies:

```bash
npm install
```

4. Create `.env.local` with at least:

```bash
DATABASE_URL=postgresql://pagescms:pagescms@localhost:5432/pagescms
BETTER_AUTH_SECRET=your-random-secret
CRYPTO_KEY=your-random-secret
```

Optional but useful:

```bash
BASE_URL=https://cms.example.com
ADMIN_EMAILS=admin@example.com
```

Notes:

- In production, `BASE_URL` should be the single canonical URL for the app.
- Do not mix a custom domain and a `*.netlify.app` URL for the same install.
- `ADMIN_EMAILS` is a comma-separated allowlist for access to the admin panel and collaborator password management. Set it to the email used by your GitHub administrator account.

Generate secrets with:

```bash
openssl rand -base64 32
```

5. Create your GitHub App with the helper:

```bash
npm run setup:github-app -- --base-url http://localhost:3000
```

Useful options:

- `--owner-type personal|org`
- `--org <slug>`
- `--app-name "Pages CMS (local)"`
- `--env .env.local`
- `--no-open`

6. Run database migrations:

```bash
npm run db:migrate
```

If cache state is known stale or corrupted, clear it with:

```bash
npm run db:clear-cache
```

7. Start the app:

```bash
npm run dev
```

If you need GitHub webhooks to reach your local app, use a public tunnel URL as the helper `--base-url`.

For more detail, see:

- [Install locally](https://pagescms.org/docs/guides/installing/)
- [Create the GitHub App](https://pagescms.org/docs/guides/installing/github-app/)
- [Environment variables](https://pagescms.org/docs/development/environment-variables/)
- [Caching](https://pagescms.org/docs/development/caching/)

## Support the project

- [Contribute code](https://github.com/pagescms/pagescms/pulls)
- [Report issues](https://github.com/pagescms/pagescms/issues)
- [Sponsor me](https://github.com/sponsors/hunvreus)
- [Star the project on GitHub](https://github.com/pagescms/pagescms)
- [Join the Discord chat](https://pagescms.org/chat)

## License

Everything in this repo is released under the [MIT License](LICENSE).

### Collaborator password logins

Administrators listed in `ADMIN_EMAILS` can create email/password accounts from a
repository's **Collaborators** page. Sign in with GitHub to manage the repository,
choose **Add collaborator**, and enter an email and a password of 12–128 characters.
Share the credentials directly; this flow sends no invitation email.

For an existing account, leave the password blank to add repository access without
changing its credentials. Use **Set password** in the collaborator menu to create
or replace its password, including for existing email-code collaborators. This
signs the account out of all existing sessions. One account/password is shared
across repositories. Removing a collaborator removes that repository's access,
not the login account. Administrator accounts continue to use GitHub sign-in.

The sign-in page accepts email and password alongside GitHub. There is no public
password registration or forgot-password flow; contact the administrator for a
replacement password. Existing invitation links retain their email-code flow.
Passwords are hashed using Better Auth's configured password hasher and never
returned in collaborator responses. No database migration is required.

Authentication integration checks can be run with Node.js 22.18+ using
`node --test tests/password-auth.test.mjs`. These exercise Better Auth with an
in-memory adapter; testing collaborator creation and repository access also
requires a configured PostgreSQL database and GitHub App.
