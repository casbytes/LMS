import crypto from "node:crypto";
import JWT from "jsonwebtoken";
import invariant from "tiny-invariant";
import { google } from "googleapis";
import { Session, createCookieSessionStorage, redirect } from "@remix-run/node";
import { type User, prisma } from "./db.server";
import { Emails } from "~/services/resend/emails.server";
import { ROLE } from "./helpers";
import { customFetch } from "./helpers.server";
import { createStripeCustomer } from "~/services/stripe.server";

export interface SessionData {
  userId: string;
}

interface SessionError {
  error: string;
}

const {
  SECRET,
  NODE_ENV,
  BASE_URL,
  COOKIE_DOMAIN,
  GITHUB_CLIENT_ID,
  GITHUB_CLIENT_SECRET,
  GOOGLE_CLIENT_ID,
  GOOGLE_CLIENT_SECRET,
} = process.env;
const MODE = NODE_ENV;

export const sessionKey = "userId";

const { getSession, commitSession, destroySession } =
  createCookieSessionStorage<SessionData, SessionError>({
    cookie: {
      name: "__casbytes_session",
      secrets: [SECRET],
      domain: COOKIE_DOMAIN,
      sameSite: "lax",
      path: "/",
      maxAge: 60 * 60 * 24 * 7,
      httpOnly: true,
      secure: MODE === "production",
    },
  });

/**
 * Get user session
 * @param request - Request
 * @returns {Session<SessionData SessionError>} - User session
 */
export async function getUserSession(
  request: Request
): Promise<Session<SessionData, SessionError>> {
  return getSession(request.headers.get("cookie"));
}

/**
 * Destroy session
 * @param {Session} session - Session
 * @returns {Promise<{headers}>} - Destroy session
 */
export async function destroyAuthSession(
  session: Session<SessionData, SessionError>
) {
  return {
    headers: {
      "set-cookie": await destroySession(session, { maxAge: 0 }),
    },
  };
}

/**
 * Commit session
 * @param {Session} session - Session
 * @returns {Promise<{headers}>} - Commit session
 */
export async function commitAuthSession(
  session: Session<SessionData, SessionError>
) {
  return {
    headers: {
      "set-cookie": await commitSession(session),
    },
  };
}

/**
 *  Sign out user
 * @param {Request} request - Request
 * @returns {TypedResponse<never>} - Redirect to home page
 */
export async function signOut(request: Request) {
  try {
    throw redirect(
      "/",
      await destroyAuthSession(await getUserSession(request))
    );
  } catch (error) {
    throw error;
  }
}

/**
 *  Get session user
 * @param request - Request
 * @returns {ISessionUser} - Session user
 */
export async function getUserId(request: Request): Promise<string> {
  try {
    const session = await getUserSession(request);
    const userId: string | undefined = session?.get(sessionKey);
    if (!userId) {
      session.flash("error", "Unauthorized.");
      throw redirect("/", await commitAuthSession(session));
    }
    return userId;
  } catch (error) {
    throw error;
  }
}

/**
 *  Get db user
 * @param {Request} request - Request
 * @returns {DBUser} - DB user
 */
export async function getUser(request: Request): Promise<User> {
  try {
    const session = await getUserSession(request);
    const userId = await getUserId(request);
    const user = await prisma.user.findUnique({
      where: { id: userId },
    });
    if (!user) {
      if (session.has(sessionKey)) {
        session.unset(sessionKey);
      }
      session.flash("error", "Unauthorized.");
      throw redirect("/", await commitAuthSession(session));
    }
    return user;
  } catch (error) {
    throw error;
  }
}

export async function checkAdmin(request: Request) {
  try {
    const user = await getUser(request);
    const session = await getUserSession(request);
    if (user.role !== (ROLE.ADMIN as ROLE)) {
      session.flash("error", "Forbidden.");
      throw redirect("/dashboard");
    }
    return null;
  } catch (error) {
    throw error;
  }
}

/**
 * Generate state
 * @returns {string} - State
 */
function generateState() {
  return crypto.randomBytes(16).toString("hex");
}

/**
 * Handle magic link redirect
 * @param request - Request
 * @returns {TypedResponse<never>}
 */
export async function handleMagiclinkRedirect(request: Request) {
  const formData = await request.formData();
  const email = formData.get("email") as string;
  const authState = generateState();

  try {
    const existingUser = await prisma.user.findUnique({
      where: { email },
      select: { email: true },
    });

    const token = JWT.sign({ email, authState }, SECRET!, {
      expiresIn: "30m",
    });

    if (!existingUser) {
      await prisma.user.create({
        data: { email, verificationToken: token, authState },
      });
    } else {
      await prisma.user.update({
        where: { email },
        data: { verificationToken: token, authState },
      });
    }

    const MAGIC_LINK = `${BASE_URL}/magic-link/callback?token=${token}`;

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { data, error } = await Emails.sendMagicLink({
      email: existingUser?.email ?? email!,
      link: MAGIC_LINK,
    });

    /**
     * The data will be used to add users to mailing list
     */

    if (error) {
      return redirect(
        `/?email=${encodeURIComponent(
          email
        )}&success=false&error=${encodeURIComponent(error.message)}`
      );
    }
    return redirect(`/?email=${encodeURIComponent(email)}&success=true`);
  } catch (error) {
    throw error;
  }
}

/**
 * Handle magic link authentication
 * @param {Request} request - Request
 * @param {Params<string>} params - Params
 * @returns {null | TypedResponse<never>}
 */
export async function handleMagiclinkCallback(request: Request) {
  const session = await getUserSession(request);
  const url = new URL(request.url);
  const token = url.searchParams.get("token");
  invariant(token, "Token is required.");

  try {
    const { email, authState } = JWT.verify(token, SECRET!) as {
      email: string;
      authState: string;
    };

    const user = await prisma.user.findUnique({
      where: { email },
    });

    if (
      !user ||
      user.verificationToken !== token ||
      user.authState !== authState
    ) {
      return redirect("/?error=Invalid token.");
    }

    if (!user.verified || !user.name) {
      return redirect(`/update-profile?email=${encodeURIComponent(email)}`);
    } else {
      await prisma.user.update({
        where: { email },
        data: { verificationToken: null, authState: null },
      });
    }

    session.set(sessionKey, user.id);

    if (user.role === (ROLE.ADMIN as ROLE)) {
      return redirect("/a", await commitAuthSession(session));
    } else {
      const redirectUrl = user.completedOnboarding
        ? user.currentUrl ?? "/dashboard"
        : "/onboarding";

      return redirect(redirectUrl, await commitAuthSession(session));
    }
  } catch (error) {
    if (error instanceof JWT.TokenExpiredError) {
      const message =
        "Your token has expired. Please generate another magic link.";
      return redirect(`/?success=false&error=${encodeURIComponent(message)}`);
    } else if (error instanceof JWT.JsonWebTokenError) {
      return redirect(
        `/?success=false&error=${encodeURIComponent(error.message)}`
      );
    }
    throw error;
  }
}

const GOOGLE_AUTH_REDIRECT_URL = `${BASE_URL}/google/callback`;

/**
 * Generate oauth2 client
 * @returns {Promise<OAuth2Client>} - OAuth2Client
 */
async function generateOauth2Client() {
  return new google.auth.OAuth2(
    GOOGLE_CLIENT_ID,
    GOOGLE_CLIENT_SECRET,
    GOOGLE_AUTH_REDIRECT_URL
  );
}

/**
 * Handle google redirect
 * @param {Request} request - Request
 * @returns {TypedResponse<never>}
 * @throws {Error}
 */
export async function handleGoogleRedirect() {
  const SCOPES = [
    "https://www.googleapis.com/auth/userinfo.email",
    "https://www.googleapis.com/auth/userinfo.profile",
  ];

  const oauth2Client = await generateOauth2Client();
  const authorizationUrl = oauth2Client.generateAuthUrl({
    access_type: "offline",
    scope: SCOPES,
    include_granted_scopes: true,
    state: generateState(),
  });
  return redirect(authorizationUrl);
}

/**
 * Handle google callback
 * @param {Request} request - Request
 * @returns {null | TypedResponse<never>}
 */
export async function handleGoogleCallback(request: Request) {
  const session = await getUserSession(request);
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const error = url.searchParams.get("error");

  invariant(code, "Code is required to authenticate user.");
  invariant(state, "State is required authenticate user.");

  if (error) {
    session.flash("error", "Failed to authenticate user, please try again.");
    throw redirect("/", await commitAuthSession(session));
  }

  const oauth2Client = await generateOauth2Client();
  const { tokens } = await oauth2Client.getToken(code);
  oauth2Client.setCredentials(tokens);

  const oauth2 = google.oauth2({
    auth: oauth2Client,
    version: "v2",
  });

  const { data: userInfo } = (await oauth2.userinfo.get()) as {
    data: { email: string; name: string; picture: string; given_name: string };
  };

  let user = await prisma.user.findUnique({
    where: { email: userInfo.email },
    select: {
      id: true,
      role: true,
      currentUrl: true,
      completedOnboarding: true,
    },
  });

  if (!user) {
    const stripeCustomer = await createStripeCustomer({
      email: userInfo.email,
      name: userInfo.name,
    });
    if (!stripeCustomer) {
      session.flash(
        "error",
        "Failed to create stripe account, please try again."
      );
      throw redirect("/", await commitAuthSession(session));
    }

    const avatar_url = `https://api.dicebear.com/9.x/avataaars/svg?seed=${userInfo.given_name}`;

    const data = {
      name: userInfo.name,
      email: userInfo.email,
      avatarUrl: userInfo?.picture?.trim() || avatar_url,
      stripeCustomerId: stripeCustomer.id,
      verified: true,
    };

    user = await prisma.user.create({
      data,
      select: {
        id: true,
        role: true,
        currentUrl: true,
        completedOnboarding: true,
      },
    });
    //send welcome email
  }

  session.set(sessionKey, user.id);

  if (user.role === (ROLE.ADMIN as ROLE)) {
    return redirect("/a", await commitAuthSession(session));
  } else {
    const redirectUrl = user.completedOnboarding
      ? user.currentUrl ?? "/dashboard"
      : "/onboarding";
    return redirect(redirectUrl, await commitAuthSession(session));
  }
}

const GITHUB_AUTH_REDIRECT_URL = `${BASE_URL}/github/callback`;

/**
 * Handle github redirect
 * @param {Request} request - Request
 * @returns {TypedResponse<never>}
 */
export async function handleGithubRedirect() {
  const state = generateState();
  const REDIRECT_URL = `https://github.com/login/oauth/authorize?client_id=${GITHUB_CLIENT_ID}&state=${state}&scope=read:user&redirect_uri=${encodeURIComponent(
    GITHUB_AUTH_REDIRECT_URL
  )}&allow_signup=true&response_type=code`;

  return redirect(REDIRECT_URL);
}

async function getGithubAccessToken(
  code: string,
  request: Request
): Promise<string> {
  const session = await getUserSession(request);

  const ACCESS_TOKEN_URL = `https://github.com/login/oauth/access_token?client_id=${GITHUB_CLIENT_ID}&client_secret=${GITHUB_CLIENT_SECRET}&code=${code}&redirect_uri=${encodeURIComponent(
    GITHUB_AUTH_REDIRECT_URL
  )}`;

  type ResponseData = {
    access_token: string;
    token_type: string;
    scope: string;
  };

  const { data: accessTokenData } = await customFetch<ResponseData>(
    ACCESS_TOKEN_URL,
    {
      method: "POST",
      headers: {
        Accept: "application/json",
      },
    }
  );

  if (!accessTokenData?.access_token) {
    session.flash("error", "Failed to fetch access token from GitHub.");
    throw redirect("/", await commitAuthSession(session));
  }

  return accessTokenData.access_token;
}

type UserData = {
  name: string;
  email: string;
  login: string;
  avatar_url: string;
};

async function getGithubUser(
  accessToken: string,
  request: Request
): Promise<UserData> {
  const session = await getUserSession(request);
  const AUTH_URL = "https://api.github.com/user";
  const { data: userRes } = await customFetch<UserData>(AUTH_URL, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });

  if (!userRes) {
    session.flash("error", "Failed to fetch user data from GitHub.");
    throw redirect("/", await commitAuthSession(session));
  }

  return userRes;
}

/**
 * Handle github callback
 * @param {Request} request - Request
 * @returns {null | TypedResponse<never>}
 */
export async function handleGithubCallback(request: Request) {
  const session = await getUserSession(request);
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  invariant(code, "Code is required to authenticate user.");
  invariant(state, "State is required authenticate user.");

  const accessToken = await getGithubAccessToken(code, request);
  const githubUser = await getGithubUser(accessToken, request);

  let user = await prisma.user.findUnique({
    where: { email: githubUser.email },
    select: {
      id: true,
      role: true,
      currentUrl: true,
      completedOnboarding: true,
    },
  });

  if (!user) {
    const stripeCustomer = await createStripeCustomer({
      email: githubUser.email,
      name: githubUser.name,
    });
    if (!stripeCustomer) {
      session.flash(
        "error",
        "Failed to create stripe account, please try again."
      );
      throw redirect("/", await commitAuthSession(session));
    }

    const avatar_url = `https://api.dicebear.com/9.x/avataaars/svg?seed=${
      githubUser.name.split(" ")[0]
    }`;

    const data = {
      name: githubUser.name,
      email: githubUser.email,
      githubUsername: githubUser.login,
      avatarUrl: githubUser.avatar_url.trim() || avatar_url,
      stripeCustomerId: stripeCustomer.id,
      verified: true,
    };

    user = await prisma.user.create({
      data,
      select: {
        id: true,
        role: true,
        currentUrl: true,
        completedOnboarding: true,
      },
    });
    //send welcome email
  }

  session.set(sessionKey, user.id);

  if (user.role === (ROLE.ADMIN as ROLE)) {
    return redirect("/a", await commitAuthSession(session));
  } else {
    const redirectUrl = user.completedOnboarding
      ? user.currentUrl ?? "/dashboard"
      : "/onboarding";
    return redirect(redirectUrl, await commitAuthSession(session));
  }
}

export { getSession, commitSession, destroySession };
