import NextAuth from "next-auth";
import CredentialsProvider from "next-auth/providers/credentials";
import GoogleProvider from "next-auth/providers/google";
import GithubProvider from "next-auth/providers/github";

// Backend API base — inside Docker this resolves to the backend service
const API_INTERNAL = process.env.API_INTERNAL_URL || "http://backend-api:4000";
const OAUTH_LOGIN_ENABLED = process.env.OAUTH_LOGIN_ENABLED === "true" || process.env.NEXT_PUBLIC_OAUTH_LOGIN_ENABLED === "true";

export const authOptions = {
  providers: [
    CredentialsProvider({
      name: "Email",
      credentials: {
        email: { label: "Email", type: "email" },
        password: { label: "Password", type: "password" },
      },
      async authorize(credentials) {
        try {
          const res = await fetch(`${API_INTERNAL}/auth/login`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              email: credentials.email,
              password: credentials.password,
            }),
          });
          const data = await res.json();
          if (!res.ok) return null;
          // Decode the JWT to get user info
          const payload = JSON.parse(
            Buffer.from(data.token.split(".")[1], "base64").toString()
          );
          return {
            id: payload.id,
            email: payload.email,
            role: payload.role,
            accessToken: data.token,
          };
        } catch {
          return null;
        }
      },
    }),

    ...(OAUTH_LOGIN_ENABLED && process.env.GOOGLE_CLIENT_ID
      ? [
          GoogleProvider({
            clientId: process.env.GOOGLE_CLIENT_ID,
            clientSecret: process.env.GOOGLE_CLIENT_SECRET,
          }),
        ]
      : []),

    ...(OAUTH_LOGIN_ENABLED && process.env.GITHUB_CLIENT_ID
      ? [
          GithubProvider({
            clientId: process.env.GITHUB_CLIENT_ID,
            clientSecret: process.env.GITHUB_CLIENT_SECRET,
          }),
        ]
      : []),
  ],

  callbacks: {
    async jwt({ token, user, account, profile }) {
      // On initial sign-in
      if (account && user) {
        if (account.provider === "credentials") {
          // Already have the platform JWT
          token.accessToken = user.accessToken;
          token.userId = user.id;
          token.role = user.role;
        } else {
          // OAuth provider — call backend to upsert user and get platform JWT
          try {
            const res = await fetch(`${API_INTERNAL}/auth/oauth-login`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                email: user.email || profile?.email,
                name: user.name || profile?.name,
                provider: account.provider,
                providerId: account.providerAccountId,
              }),
            });
            const data = await res.json();
            if (res.ok) {
              token.accessToken = data.token;
              token.userId = data.user.id;
              token.role = data.user.role;
            }
          } catch (e) {
            console.error("OAuth backend upsert failed:", e);
          }
        }
      }
      return token;
    },

    async session({ session, token }) {
      session.accessToken = token.accessToken;
      session.user.id = token.userId;
      session.user.role = token.role;
      return session;
    },

    async redirect({ url, baseUrl }) {
      // After sign-in, send users to the callback bridge page
      if (url.startsWith(baseUrl)) return url;
      return `${baseUrl}/auth/callback`;
    },
  },

  pages: {
    signIn: "/login",
    error: "/login",
  },

  secret: process.env.NEXTAUTH_SECRET,
  session: { strategy: "jwt", maxAge: 7 * 24 * 60 * 60 },
};

export default NextAuth(authOptions);
