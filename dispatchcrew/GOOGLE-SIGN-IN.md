# Google sign-in setup

Demo accounts work without Google or passwords. Google sign-in is optional and is not enabled by these console steps alone.

1. Open https://console.cloud.google.com/projectcreate and create a project named **AlphaQ**.
2. Open **Google Auth Platform → Branding → Get started**. Enter AlphaQ, your support email and your contact email.
3. Choose **External** for the audience. Keep the app in **Testing** and add your Google email and the demo presenters under **Audience → Test users**.
4. Under **Data Access**, request only `openid`, `email` and `profile`. Gmail, Drive and Calendar access are unnecessary.
5. Open **Clients → Create client → Web application**. Name it **AlphaQ Web**.
6. Add these authorized JavaScript origins:
   - `http://127.0.0.1:5173`
   - `http://localhost:5173`
   - The final Vercel production origin, without a trailing slash.
7. For a server authorization-code integration, reserve these exact redirect URIs:
   - `http://127.0.0.1:5173/api/auth/google/callback`
   - `http://localhost:5173/api/auth/google/callback`
   - `https://YOUR-ALPHAQ-DOMAIN/api/auth/google/callback`
8. Create the client. Store its values in your local ignored `.env` as `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`. Never use a `VITE_` prefix for the secret. Save the secret when Google displays it.
9. Add the same values to the AlphaQ project's Vercel environment settings. Set `APP_ORIGIN` to its final HTTPS origin, then redeploy after the server integration is implemented.

The server integration must validate state, nonce, PKCE, issuer, audience, expiry and verified email. Identify Google accounts by Google's stable `sub`. An existing password account must be linked through an authenticated flow or an invitation, not silently merged by email. Public Google sign-up creates a customer; staff, managers and owners retain invitation-controlled permissions. A selected role on the login page cannot grant privileges.

The callback addresses above are reserved configuration targets. The current release uses password sign-in and isolated demo-role sessions; Google endpoints will be added in the optional OAuth implementation.

References: https://developers.google.com/identity/protocols/oauth2/web-server and https://developers.google.com/workspace/guides/configure-oauth-consent
