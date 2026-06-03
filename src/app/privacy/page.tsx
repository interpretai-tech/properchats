import Link from "next/link";
import { Logo } from "@/components/Logo";

export const metadata = {
  title: "Privacy Policy",
  description: "How ProperChat handles your data.",
};

export default function PrivacyPage() {
  return (
    <div className="min-h-screen bg-bg text-ink">
      <header className="border-b border-line">
        <div className="mx-auto flex max-w-3xl items-center px-6 py-4">
          <Link
            href="/"
            className="flex items-center gap-2 text-ink transition-opacity hover:opacity-80"
            aria-label="ProperChat home"
          >
            <span className="flex h-7 w-7 items-center justify-center rounded-md bg-accent text-accent-fg">
              <Logo size={20} />
            </span>
            <span className="text-sm font-semibold">ProperChat</span>
          </Link>
        </div>
      </header>

      <main className="mx-auto max-w-3xl px-6 py-12 sm:py-16">
        <h1 className="text-3xl font-semibold tracking-tight text-ink">
          Privacy Policy
        </h1>
        <p className="mt-2 text-sm text-faint">Effective date: June 1, 2026</p>

        <div className="mt-8 space-y-8 text-[15px] leading-relaxed text-muted">
          <section className="space-y-3">
            <p>
              This Privacy Policy explains what information ProperChat (also
              branded BranchChat, available at properchats.ai and branchchat.ai)
              collects, how we use it, and the choices you have. ProperChat lets
              you chat with multiple AI models and organize replies into chats
              and threads. By using the service, you agree to the practices
              described here.
            </p>
          </section>

          <section className="space-y-3">
            <h2 className="text-xl font-semibold text-ink">
              Information we collect
            </h2>
            <p>
              ProperChat does not require an account, and we do not collect a
              profile, contact details, or payment information from you.
            </p>
            <ul className="list-disc space-y-2 pl-5">
              <li>
                <span className="font-medium text-ink">
                  Conversations and content.
                </span>{" "}
                Your chats and threads are stored locally in your browser. We do
                not keep a copy of them on our servers.
              </li>
              <li>
                <span className="font-medium text-ink">Prompts you send.</span>{" "}
                To generate a reply, the messages for that turn are sent to the
                model provider you choose so it can produce a response.
              </li>
            </ul>
          </section>

          <section className="space-y-3">
            <h2 className="text-xl font-semibold text-ink">
              How we use your information
            </h2>
            <ul className="list-disc space-y-2 pl-5">
              <li>To provide, maintain, and improve the service.</li>
              <li>To route your prompts to the model provider you select.</li>
              <li>
                To secure the service and protect against abuse and fraud.
              </li>
            </ul>
          </section>

          <section className="space-y-3">
            <h2 className="text-xl font-semibold text-ink">
              Where your data is stored and processed
            </h2>
            <ul className="list-disc space-y-2 pl-5">
              <li>
                <span className="font-medium text-ink">
                  Your browser&apos;s local storage.
                </span>{" "}
                Your chats, settings, and any provider keys you add live in your
                browser&apos;s local storage. Clearing your browser data removes
                them.
              </li>
              <li>
                <span className="font-medium text-ink">Model providers.</span>{" "}
                To generate replies, your prompts are sent to the model provider
                you choose: Anthropic (Claude), OpenAI (ChatGPT), Google
                (Gemini), or the InterpretAI gateway.
              </li>
            </ul>
          </section>

          <section className="space-y-3">
            <h2 className="text-xl font-semibold text-ink">
              Bring your own keys
            </h2>
            <p>
              If you add your own provider API keys, they are stored in your
              browser and sent to our proxy with each request so we can call
              that provider on your behalf. We do not store your keys on our
              servers.
            </p>
          </section>

          <section className="space-y-3">
            <h2 className="text-xl font-semibold text-ink">
              Third-party services
            </h2>
            <p>
              To generate replies we rely on model providers: InterpretAI,
              Anthropic, OpenAI, and Google. These providers handle the prompts
              sent to them under their own privacy policies.
            </p>
          </section>

          <section className="space-y-3">
            <h2 className="text-xl font-semibold text-ink">
              Data retention and deletion
            </h2>
            <p>
              You can delete individual chats at any time, and clearing your
              browser&apos;s storage removes all of your chats, settings, and
              keys. Because this data lives in your browser, you are in control
              of it.
            </p>
          </section>

          <section className="space-y-3">
            <h2 className="text-xl font-semibold text-ink">
              Children&apos;s privacy
            </h2>
            <p>
              ProperChat is not directed to children under 13, and we do not
              knowingly collect personal information from them. If you believe a
              child has provided us information, please contact us so we can
              remove it.
            </p>
          </section>

          <section className="space-y-3">
            <h2 className="text-xl font-semibold text-ink">Security</h2>
            <p>
              We use reasonable safeguards to protect your information. No method
              of transmission or storage is 100% secure, so we cannot guarantee
              absolute security.
            </p>
          </section>

          <section className="space-y-3">
            <h2 className="text-xl font-semibold text-ink">
              Changes to this policy
            </h2>
            <p>
              We may update this Privacy Policy from time to time. When we do, we
              will revise the effective date shown at the top of this page.
            </p>
          </section>

          <section className="space-y-3">
            <h2 className="text-xl font-semibold text-ink">Contact us</h2>
            <p>
              Questions about this policy or your data? Email us at{" "}
              <a
                href="mailto:privacy@properchats.ai"
                className="text-accent underline underline-offset-2"
              >
                privacy@properchats.ai
              </a>
              .
            </p>
          </section>
        </div>
      </main>
    </div>
  );
}
