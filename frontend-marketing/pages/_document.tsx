import Document, { Head, Html, Main, NextScript, type DocumentContext } from "next/document";
import { DEFAULT_LOCALE, normalizeLocale } from "../lib/i18n";

export default class MarketingDocument extends Document {
  static async getInitialProps(ctx: DocumentContext) {
    return Document.getInitialProps(ctx);
  }

  render() {
    const locale = normalizeLocale(this.props.locale || DEFAULT_LOCALE);
    return (
      <Html lang={locale}>
        <Head>
          {/* Favicons & app icons */}
          <link rel="icon" href="/favicon.ico" sizes="any" />
          <link rel="icon" type="image/png" sizes="32x32" href="/favicon-32x32.png" />
          <link rel="icon" type="image/png" sizes="16x16" href="/favicon-16x16.png" />
          <link rel="apple-touch-icon" href="/apple-touch-icon.png" />
          <link rel="manifest" href="/site.webmanifest" />
          <meta name="theme-color" content="#071018" />
        </Head>
        <body>
          <Main />
          <NextScript />
        </body>
      </Html>
    );
  }
}
