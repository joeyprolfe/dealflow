import AzureADProvider from 'next-auth/providers/azure-ad'

export const authOptions = {
  // Explicitly set — never rely on auto-detection across Vercel deployments
  secret: process.env.NEXTAUTH_SECRET,

  session: {
    strategy: 'jwt',
    // Extend session lifetime so tokens don't expire mid-use
    maxAge: 24 * 60 * 60, // 24 hours
  },

  providers: [
    AzureADProvider({
      clientId: process.env.AZURE_AD_CLIENT_ID,
      clientSecret: process.env.AZURE_AD_CLIENT_SECRET,
      tenantId: process.env.AZURE_AD_TENANT_ID || 'common',
      authorization: {
        params: {
          scope: 'openid profile email offline_access Mail.Read User.Read',
        },
      },
    }),
  ],

  callbacks: {
    async jwt({ token, account }) {
      if (account) {
        token.accessToken = account.access_token
        token.expiresAt = account.expires_at
      }
      return token
    },
    async session({ session, token }) {
      session.accessToken = token.accessToken
      return session
    },
  },

  pages: {
    signIn: '/',
  },
}
