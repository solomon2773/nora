import "../styles/globals.css";
import Script from "next/script";
import { AuthBootstrapProvider } from "../components/AuthBootstrapProvider";
import { ToastProvider } from "../components/Toast";
import { I18nProvider } from "../lib/i18n";
import { ANALYTICS_DOMAIN, ANALYTICS_ENABLED, ANALYTICS_SRC } from "../lib/analytics";

function MyApp({ Component, pageProps: { session, ...pageProps } }) {
  return (
    <AuthBootstrapProvider>
      <I18nProvider>
        <ToastProvider>
          {ANALYTICS_ENABLED && (
            <Script
              defer
              data-domain={ANALYTICS_DOMAIN}
              src={ANALYTICS_SRC}
              strategy="afterInteractive"
            />
          )}
          <Component {...pageProps} />
        </ToastProvider>
      </I18nProvider>
    </AuthBootstrapProvider>
  );
}

export default MyApp;
