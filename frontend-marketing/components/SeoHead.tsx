import Head from "next/head";
import { useRouter } from "next/router";
import { LOCALES, localizePath, normalizeLocale } from "../lib/i18n";

const SITE_ORIGIN = (process.env.NEXT_PUBLIC_SITE_URL || "https://norafleet.ai").replace(
  /\/+$/,
  "",
);
const DEFAULT_IMAGE_PATH = "/og-image.png";

const OPEN_GRAPH_LOCALES = {
  en: "en_US",
  es: "es_ES",
  fr: "fr_FR",
  "zh-Hans": "zh_CN",
  "zh-Hant": "zh_TW",
} as const;

type SeoHeadProps = {
  title: string;
  description: string;
  path: string;
  imagePath?: string;
  imageAlt?: string;
  noIndex?: boolean;
  structuredData?: Record<string, unknown>;
};

function absoluteUrl(path: string) {
  return new URL(path, `${SITE_ORIGIN}/`).toString();
}

export default function SeoHead({
  title,
  description,
  path,
  imagePath = DEFAULT_IMAGE_PATH,
  imageAlt = "Nora self-hosted AI agent control plane",
  noIndex = false,
  structuredData,
}: SeoHeadProps) {
  const router = useRouter();
  const locale = normalizeLocale(router.locale);
  const canonicalUrl = absoluteUrl(localizePath(path, locale));
  const imageUrl = absoluteUrl(imagePath);

  return (
    <Head>
      <title>{title}</title>
      <meta name="description" content={description} key="description" />
      <meta
        name="robots"
        content={
          noIndex
            ? "noindex, nofollow"
            : "index, follow, max-image-preview:large, max-snippet:-1, max-video-preview:-1"
        }
        key="robots"
      />
      <link rel="canonical" href={canonicalUrl} key="canonical" />
      {LOCALES.map((alternateLocale) => (
        <link
          key={`alternate-${alternateLocale}`}
          rel="alternate"
          hrefLang={alternateLocale}
          href={absoluteUrl(localizePath(path, alternateLocale))}
        />
      ))}
      <link rel="alternate" hrefLang="x-default" href={absoluteUrl(path)} key="alternate-default" />

      <meta property="og:type" content="website" key="og:type" />
      <meta property="og:site_name" content="Nora" key="og:site_name" />
      <meta property="og:title" content={title} key="og:title" />
      <meta property="og:description" content={description} key="og:description" />
      <meta property="og:url" content={canonicalUrl} key="og:url" />
      <meta property="og:locale" content={OPEN_GRAPH_LOCALES[locale]} key="og:locale" />
      <meta property="og:image" content={imageUrl} key="og:image" />
      <meta property="og:image:width" content="1200" key="og:image:width" />
      <meta property="og:image:height" content="630" key="og:image:height" />
      <meta property="og:image:alt" content={imageAlt} key="og:image:alt" />

      <meta name="twitter:card" content="summary_large_image" key="twitter:card" />
      <meta name="twitter:title" content={title} key="twitter:title" />
      <meta name="twitter:description" content={description} key="twitter:description" />
      <meta name="twitter:image" content={imageUrl} key="twitter:image" />
      <meta name="twitter:image:alt" content={imageAlt} key="twitter:image:alt" />

      {structuredData ? (
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(structuredData) }}
          key="structured-data"
        />
      ) : null}
    </Head>
  );
}
