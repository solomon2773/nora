import Link from "next/link";
import SeoHead from "../components/SeoHead";

// NOTE: Boilerplate for a self-hosted-OSS product + hosted reference deployment.
// Have it reviewed by counsel and set a real contact address before launch.
const LAST_UPDATED = "May 26, 2026";
const REPO_URL = "https://github.com/solomon2773/nora";
const LICENSE_URL = `${REPO_URL}/blob/master/LICENSE`;
const CONTACT_EMAIL = "legal@solomontsao.com";

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h2 className="text-xl font-black text-brand-ink sm:text-2xl">{title}</h2>
      <div className="mt-3 space-y-3">{children}</div>
    </section>
  );
}

export default function Terms() {
  return (
    <>
      <SeoHead
        title="Terms of Service | Nora"
        description="Terms for the hosted Nora reference deployment. The Nora software remains open source under the Apache 2.0 License."
        path="/terms"
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
            Terms of Service
          </h1>
          <p className="mt-3 text-sm font-semibold text-slate-600">Last updated: {LAST_UPDATED}</p>

          <div className="mt-10 space-y-9 text-base leading-8 text-slate-700">
            <Section title="Acceptance of terms">
              <p>
                These terms govern your use of the <strong>hosted reference deployment</strong> of
                Nora at nora.solomontsao.com. By creating an account or using the hosted service,
                you agree to these terms. If you do not agree, do not use the hosted service.
              </p>
            </Section>

            <Section title="The software is open source">
              <p>
                The Nora software is licensed under the{" "}
                <a
                  className="font-bold text-brand-ink underline underline-offset-4"
                  href={LICENSE_URL}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Apache License 2.0
                </a>
                . You are free to self-host, modify, and use it commercially under that license.
                These terms apply only to the hosted reference deployment we operate — not to
                instances you run yourself.
              </p>
            </Section>

            <Section title="Accounts">
              <p>
                You are responsible for the activity under your account and for keeping your
                credentials secure. Provide accurate information at signup and notify us of any
                unauthorized use.
              </p>
            </Section>

            <Section title="Acceptable use">
              <p>You agree not to use the hosted service to:</p>
              <ul className="list-disc space-y-2 pl-5">
                <li>break the law or infringe others’ rights;</li>
                <li>
                  attack, disrupt, or probe the service or its infrastructure without authorization;
                </li>
                <li>attempt to access accounts or data that are not yours; or</li>
                <li>abuse connected third-party providers in violation of their terms.</li>
              </ul>
            </Section>

            <Section title="Third-party providers and costs">
              <p>
                Nora connects to LLM and integration providers using credentials you supply. You are
                responsible for those accounts, for complying with their terms, and for any usage
                charges they bill you. Nora is not responsible for third-party availability, output,
                or costs.
              </p>
            </Section>

            <Section title="No warranty">
              <p>
                The hosted service is provided “as is” and “as available,” without warranties of any
                kind, to the maximum extent permitted by law. This mirrors the warranty disclaimer
                in the Apache 2.0 License.
              </p>
            </Section>

            <Section title="Limitation of liability">
              <p>
                To the maximum extent permitted by law, we are not liable for any indirect,
                incidental, or consequential damages, or for loss of data, profits, or revenue,
                arising from your use of the hosted service.
              </p>
            </Section>

            <Section title="Termination">
              <p>
                We may suspend or terminate access to the hosted service for violations of these
                terms or to protect the service. You may stop using it and delete your account at
                any time.
              </p>
            </Section>

            <Section title="Changes">
              <p>
                We may update these terms from time to time. Material changes will be reflected by
                the “Last updated” date above; continued use after changes means you accept them.
              </p>
            </Section>

            <Section title="Contact">
              <p>
                Questions about these terms? Email{" "}
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
            <Link href="/privacy" className="hover:text-brand-ink">
              Privacy Policy
            </Link>
          </div>
        </main>
      </div>
    </>
  );
}
