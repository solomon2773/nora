import Link from "next/link";
import SeoHead from "../components/SeoHead";

// NOTE: Boilerplate for a self-hosted-OSS product + hosted reference deployment.
// Have it reviewed by counsel and set a real contact address before launch.
const LAST_UPDATED = "May 26, 2026";
const REPO_URL = "https://github.com/solomon2773/nora";
const CONTACT_EMAIL = "privacy@solomontsao.com";

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h2 className="text-xl font-black text-brand-ink sm:text-2xl">{title}</h2>
      <div className="mt-3 space-y-3">{children}</div>
    </section>
  );
}

export default function Privacy() {
  return (
    <>
      <SeoHead
        title="Privacy Policy | Nora"
        description="How the hosted Nora reference deployment handles data, and how data ownership differs when you run Nora on your own infrastructure."
        path="/privacy"
      />

      <div className="site-shell min-h-screen px-4 pb-16 pt-4 text-brand-ink sm:px-6">
        <header className="mx-auto flex max-w-3xl items-center justify-between rounded-2xl border border-brand-cyan/25 bg-white/90 px-4 py-3 shadow-xl shadow-brand-ink/10 backdrop-blur-xl sm:px-5">
          <Link href="/" className="flex items-center gap-3">
            <img src="/logo-mark.png" alt="Nora" width={40} height={40} className="h-10 w-10" />
            <div className="text-sm font-black uppercase tracking-[0.28em] text-brand-ink">
              Nora
            </div>
          </Link>
          <div className="flex items-center gap-3">
            <Link
              href="/login"
              className="rounded-full border border-brand-ink/10 px-4 py-2 text-sm font-bold text-brand-ink transition-colors hover:bg-brand-cyan/16"
            >
              Log In
            </Link>
            <Link
              href="/signup"
              className="rounded-full bg-brand-cyan px-4 py-2 text-sm font-black text-brand-ink shadow-lg shadow-brand-cyan/25 transition-transform hover:-translate-y-0.5"
            >
              Create Account
            </Link>
          </div>
        </header>

        <main className="mx-auto max-w-3xl pt-12">
          <h1 className="text-4xl font-black leading-tight text-brand-ink sm:text-5xl">
            Privacy Policy
          </h1>
          <p className="mt-3 text-sm font-semibold text-slate-600">Last updated: {LAST_UPDATED}</p>

          <div className="mt-10 space-y-9 text-base leading-8 text-slate-700">
            <Section title="Overview">
              <p>
                Nora is open-source software you can run yourself. This Privacy Policy describes how
                personal data is handled on the <strong>hosted reference deployment</strong>{" "}
                operated at nora.solomontsao.com. If you run Nora on your own infrastructure, you
                are the data controller for that instance and this policy does not apply to it.
              </p>
            </Section>

            <Section title="Data we collect">
              <ul className="list-disc space-y-2 pl-5">
                <li>
                  <strong>Account data:</strong> the email address and password you provide at
                  signup. Passwords are stored only as salted bcrypt hashes — never in plain text.
                </li>
                <li>
                  <strong>Provider credentials:</strong> any LLM provider or integration API keys
                  you add are encrypted at rest (AES-256-GCM) and used only to operate your agents.
                </li>
                <li>
                  <strong>Operational data:</strong> the agents, workspaces, deployments, logs, and
                  metrics you create while using the platform.
                </li>
                <li>
                  <strong>Session data:</strong> an HttpOnly session cookie used to keep you signed
                  in.
                </li>
              </ul>
            </Section>

            <Section title="How we use data">
              <p>
                Data is used solely to provide and operate the service: authenticating you, running
                and monitoring your agents, and maintaining your account. We do not sell personal
                data or use it for third-party advertising.
              </p>
            </Section>

            <Section title="Third-party services">
              <p>
                The hosted deployment may rely on third parties you choose to connect or that are
                required to operate it — for example OAuth providers (Google, GitHub) if you sign in
                with them, your configured LLM and integration providers, and a payment processor
                (Stripe) if you use PaaS billing. Data shared with these services is governed by
                their own privacy policies.
              </p>
            </Section>

            <Section title="Data retention and security">
              <p>
                Account and operational data is retained while your account is active. Secrets are
                encrypted at rest and transmitted over TLS. No system is perfectly secure, but we
                apply standard safeguards including encryption, hashed passwords, and access
                controls.
              </p>
            </Section>

            <Section title="Your choices">
              <p>
                You may request access to or deletion of your account data by contacting us.
                Deleting your account removes your associated account and operational data from the
                hosted deployment.
              </p>
            </Section>

            <Section title="Self-hosted instances">
              <p>
                When you self-host Nora, all data stays within your own infrastructure. You are
                responsible for the privacy practices, security, and any applicable compliance of
                the instances you operate.
              </p>
            </Section>

            <Section title="Changes">
              <p>
                We may update this policy from time to time. Material changes will be reflected by
                the “Last updated” date above.
              </p>
            </Section>

            <Section title="Contact">
              <p>
                Questions about this policy? Email{" "}
                <a
                  className="font-bold text-brand-ink underline underline-offset-4"
                  href={`mailto:${CONTACT_EMAIL}`}
                >
                  {CONTACT_EMAIL}
                </a>{" "}
                or open an issue on{" "}
                <a
                  className="font-bold text-brand-ink underline underline-offset-4"
                  href={REPO_URL}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  GitHub
                </a>
                .
              </p>
            </Section>
          </div>

          <div className="mt-12 flex flex-wrap gap-6 border-t border-brand-ink/10 pt-6 text-sm font-semibold text-slate-600">
            <Link href="/" className="hover:text-brand-ink">
              ← Back to home
            </Link>
            <Link href="/terms" className="hover:text-brand-ink">
              Terms of Service
            </Link>
          </div>
        </main>
      </div>
    </>
  );
}
