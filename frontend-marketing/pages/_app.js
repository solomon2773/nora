import "../styles/globals.css";
import { SessionProvider } from "next-auth/react";
import { ToastProvider } from "../components/Toast";

function MyApp({ Component, pageProps: { session, ...pageProps } }) {
  return (
    <SessionProvider session={session}>
      <ToastProvider>
        <Component {...pageProps} />
      </ToastProvider>
    </SessionProvider>
  );
}

export default MyApp;
