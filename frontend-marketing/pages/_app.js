import "../styles/globals.css";
import { SessionProvider } from "next-auth/react";
import { ToastProvider } from "../components/Toast";
import { useEffect } from "react";
import { useRouter } from "next/router";

const PUBLIC_PATHS = ["/login", "/signup"];

function MyApp({ Component, pageProps: { session, ...pageProps } }) {
  const router = useRouter();

  useEffect(() => {
    if (process.env.NEXT_PUBLIC_PLATFORM_MODE !== "selfhosted") return;
    if (PUBLIC_PATHS.includes(router.pathname)) return;

    const token = localStorage.getItem("token");
    if (token) {
      window.location.href = "/app/dashboard";
    } else {
      window.location.href = "/login";
    }
  }, [router.pathname]);

  return (
    <SessionProvider session={session}>
      <ToastProvider>
        <Component {...pageProps} />
      </ToastProvider>
    </SessionProvider>
  );
}

export default MyApp;
